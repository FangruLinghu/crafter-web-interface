#!/usr/bin/env python3
"""Task-local integration for an unmodified ptc_agent_merged checkout.

This adapter invokes MinerU, invokes the existing pipeline, and adapts
its transport. It does not replace any planning, generation, or debug algorithm.
"""
import sys

sys.dont_write_bytecode = True

import argparse
import importlib
import importlib.util
import inspect
from contextlib import redirect_stdout
import io
from functools import wraps
import json
import logging
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import stat
import subprocess
import threading
import time
from urllib.parse import urlsplit


KEY_NAME = re.compile(r"(?:API_KEY|API_TOKEN|ACCESS_TOKEN|SECRET|PASSWORD|TOKEN)", re.I)
PARSER_NOTICE = (
    "MinerU is the only PDF preprocessing path. Readiness checks package availability "
    "and the Crafter entrypoint, not model weights, backend compatibility, or an actual PDF parse. "
    "Independent Crafter figure analysis is disabled for this single-model profile."
)
EXCLUDED_PARTS = {".git", ".venv", "venv", "env", "__pycache__", "node_modules"}
IMPLEMENTATION_SUFFIXES = {".py", ".pyx", ".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx",
                           ".c", ".cpp", ".cc", ".h", ".hpp", ".cu", ".rs", ".go", ".jl",
                           ".r", ".java", ".scala", ".swift", ".m", ".ipynb", ".sh"}


class AdapterError(RuntimeError):
    pass


def emit(event, **fields):
    print(json.dumps({"event": event, **fields}, ensure_ascii=False), flush=True)


def strip_credentials(environment, secret=""):
    return {
        name: value for name, value in environment.items()
        if not KEY_NAME.search(name) and not (secret and secret in value)
    }


def drop_credentials():
    for name in list(os.environ):
        if KEY_NAME.search(name):
            os.environ.pop(name, None)


def repo_path(value):
    if not value or not Path(value).is_absolute():
        raise AdapterError("--repo must name the absolute path of the existing Crafter checkout.")
    root = Path(value).resolve()
    if not (root / "src/main.py").is_file() or not (root / "src/utils/llm_client.py").is_file():
        raise AdapterError("The selected checkout does not contain src/main.py and src/utils/llm_client.py.")
    return root


def task_paths(require_output=False):
    names = {"input": "CRAFTER_INPUT", "work": "CRAFTER_WORK"}
    if require_output:
        names["output"] = "CRAFTER_OUTPUT"
    result = {}
    for label, name in names.items():
        raw = os.environ.get(name, "")
        if not raw or not Path(raw).is_absolute():
            raise AdapterError(f"{name} must name an absolute task-local path.")
        original = Path(raw)
        if original.is_symlink():
            raise AdapterError(f"{name} must not be a symbolic link.")
        result[label] = original.resolve()
    if not result["input"].is_file():
        raise AdapterError("The retained task PDF is unavailable.")
    result["work"].mkdir(parents=True, exist_ok=True)
    if require_output:
        result["output"].mkdir(parents=True, exist_ok=True)
        work, output = result["work"], result["output"]
        if work == output or work in output.parents or output in work.parents:
            raise AdapterError("Internal work and published output directories must be separate.")
    return result


def isolate_runtime(work):
    """Keep temporary files and optional library caches inside task accounting."""
    for name, relative in {"TMPDIR": "tmp", "TMP": "tmp", "TEMP": "tmp",
                           "XDG_CACHE_HOME": "cache", "HF_HOME": "cache/huggingface",
                           "PIP_CACHE_DIR": "cache/pip"}.items():
        location = work / relative
        location.mkdir(parents=True, exist_ok=True)
        os.environ[name] = str(location)
    # Clear inherited run-wide destinations; the upstream CLI must write into
    # this task, even when the server was launched from an experiment shell.
    for name in list(os.environ):
        if name.startswith("PTC_"):
            os.environ.pop(name, None)


def validate_content_list(value):
    if not isinstance(value, list) or not value:
        raise AdapterError("The parser produced no page content.")
    count = 0
    for page in value:
        if not isinstance(page, list):
            raise AdapterError("The parser must produce MinerU v2 nested page/item lists.")
        for item in page:
            if not isinstance(item, dict) or not isinstance(item.get("type"), str) or not isinstance(item.get("content"), dict):
                raise AdapterError("The parser produced an invalid MinerU v2 item.")
            count += 1
    if not count:
        raise AdapterError("The parser produced no readable paper content.")
    return value


def safe_tree_files(root):
    root = Path(root)
    if root.is_symlink() or not root.is_dir():
        raise AdapterError("Expected output directory is missing or is a symbolic link.")
    resolved = root.resolve()
    files = []
    for candidate in sorted(root.rglob("*")):
        relative = candidate.relative_to(root)
        info = candidate.lstat()
        if stat.S_ISLNK(info.st_mode) or (not stat.S_ISDIR(info.st_mode) and not stat.S_ISREG(info.st_mode)):
            raise AdapterError("Generated output contains a symbolic link or special file.")
        if resolved not in candidate.resolve().parents:
            raise AdapterError("Generated output escaped its task directory.")
        if stat.S_ISREG(info.st_mode):
            if info.st_nlink != 1:
                raise AdapterError("Generated output contains a hard-linked file.")
            files.append((relative, candidate))
    return files


def preprocess(args):
    # The parsing service is team configured. Remove the task's model credential
    # before creating the MinerU subprocess.
    drop_credentials()
    locations = task_paths()
    work = locations["work"]
    isolate_runtime(work)
    os.chdir(work)
    parsed = work / "parsed"
    parsed.mkdir(exist_ok=True)
    (parsed / "images").mkdir(exist_ok=True)
    command = [sys.executable, "-B", "-m", "mineru.cli.client", "-p", str(locations["input"]),
               "-o", str(work / "mineru"), "-b", args.mineru_backend, "-m", "auto"]
    if args.mineru_source:
        command += ["--source", args.mineru_source]
    if args.mineru_url:
        command += ["-u", args.mineru_url]
    if args.mineru_backend.endswith("http-client") and not args.mineru_url:
        raise AdapterError("A team-configured --mineru-url is required for the selected HTTP parser backend.")
    emit("preprocessing", parser="mineru", backend=args.mineru_backend)
    completed = subprocess.run(command, env=strip_credentials(os.environ), check=False)
    if completed.returncode:
        raise AdapterError(f"MinerU exited with code {completed.returncode}.")
    candidates = sorted((work / "mineru").rglob("*_content_list_v2.json"))
    if len(candidates) != 1:
        raise AdapterError("MinerU did not produce exactly one v2 content list. Check its retained log; MinerU may log parser errors without a nonzero exit.")
    source = candidates[0]
    if source.is_symlink() or source.stat().st_nlink != 1:
        raise AdapterError("MinerU content output must be a regular task-local file.")
    try:
        content = validate_content_list(json.loads(source.read_text(encoding="utf8")))
    except (OSError, ValueError) as error:
        raise AdapterError("MinerU produced unreadable or invalid JSON content output.") from error
    (parsed / "paper_content_list_v2.json").write_text(json.dumps(content, ensure_ascii=False, indent=2), encoding="utf8")
    image_dir = source.parent / "images"
    if image_dir.exists():
        for relative, candidate in safe_tree_files(image_dir):
            destination = parsed / "images" / relative
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(candidate, destination)
    details = {"parser": "mineru", "pages": len(content), "backend": args.mineru_backend,
               "limitations": "Parser extraction is not a scientific correctness guarantee; independent Crafter figure analysis remains disabled for the single-model web interface."}
    (work / "preprocessing.json").write_text(json.dumps(details, ensure_ascii=False, indent=2), encoding="utf8")
    emit("preprocessing_complete", **details)


def _redact(text, secret):
    return str(text).replace(secret, "[REDACTED]") if secret else str(text)


def protect_memory_writers(secret):
    global_memory = importlib.import_module("src.memory.global_memory")
    local_memory = importlib.import_module("src.memory.local_memory")
    global_write = global_memory.GlobalMemory._write_file
    local_write = local_memory.LocalMemory._write_to_disk

    @wraps(global_write)
    def write_global(self, key, text, extension):
        return global_write(self, key, _redact(text, secret), extension)

    @wraps(local_write)
    def write_local(self, text):
        return local_write(self, _redact(text, secret))

    global_memory.GlobalMemory._write_file = write_global
    local_memory.LocalMemory._write_to_disk = write_local


def finish_memory_writers(timeout=30):
    deadline = time.monotonic() + timeout
    while True:
        writers = [thread for thread in threading.enumerate()
                   if thread is not threading.current_thread()
                   and getattr(getattr(thread, "_target", None), "__module__", "").startswith("src.memory.")]
        if not writers:
            return
        for thread in writers:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise AdapterError("Crafter memory writers did not finish; outputs were not published.")
            thread.join(min(remaining, 1))


def safe_relative(value):
    if not isinstance(value, str) or not value or "\\" in value or "\0" in value:
        raise AdapterError("Crafter produced an invalid generated file path.")
    relative = PurePosixPath(value)
    if relative.is_absolute() or any(part in ("", ".", "..") for part in value.split("/")):
        raise AdapterError("Crafter generated file paths must stay inside the task codebase.")
    return relative


def protect_codegen_paths(expected_codebase, published_output=None, secret=""):
    module = importlib.import_module("src.agents.codegen_agent")
    original = module.CodegenAgent.run
    expected_codebase = Path(expected_codebase).resolve()

    async def guarded(self, *args, **kwargs):
        relative = safe_relative(self.file_path)
        raw_base = Path(self.codebase_dir).absolute()
        base = raw_base.resolve()
        if base != expected_codebase or raw_base.is_symlink():
            raise AdapterError("Crafter codebase directory escaped its task working directory.")
        target = base.joinpath(*relative.parts)
        if base not in target.resolve().parents:
            raise AdapterError("Crafter generated file path escaped its task codebase.")
        for ancestor in [target, *target.parents]:
            if ancestor == base:
                break
            if ancestor.is_symlink():
                raise AdapterError("Crafter generated file path contains a symbolic link.")
        result = await original(self, *args, **kwargs)
        # Keep completed generation artifacts available even if a later timeout
        # force-kills Python before its finally block can publish partial files.
        # The HTTP layer keeps these files private until task termination.
        if published_output is not None:
            info = target.lstat()
            if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
                raise AdapterError("A finished generated file is not a regular task-local file.")
            _copy_protected(target, Path(published_output) / "codebase" / relative, secret)
        return result

    module.CodegenAgent.run = guarded


def verify_codebase(codebase, architecture):
    files = safe_tree_files(codebase)
    indexed = {relative.as_posix(): source for relative, source in files}
    planned = architecture.get("files", []) if isinstance(architecture, dict) else []
    if not isinstance(planned, list) or not planned:
        raise AdapterError("Crafter produced no architecture with generated files; a fallback reproduce.sh is not a successful result.")
    actual = []
    for entry in planned:
        if not isinstance(entry, dict):
            raise AdapterError("Crafter produced an invalid architecture file entry.")
        name = safe_relative(entry.get("path")).as_posix()
        source = indexed.get(name)
        if not source:
            raise AdapterError("A planned Crafter output file is missing.")
        if source.stat().st_size and name not in {"reproduce.sh", "requirements.txt"} and Path(name).name != "__init__.py" and Path(name).suffix.lower() in IMPLEMENTATION_SUFFIXES:
            actual.append(name)
    if not actual:
        raise AdapterError("Crafter did not generate a nonempty planned implementation file.")
    if "requirements.txt" not in indexed or "reproduce.sh" not in indexed:
        raise AdapterError("Crafter did not produce its required requirements.txt and reproduce.sh outputs.")
    return files, actual


def _copy_protected(source, destination, secret):
    raw = source.read_bytes()
    if secret and secret.encode() in raw:
        try:
            raw = raw.decode("utf8").replace(secret, "[REDACTED]").encode("utf8")
        except UnicodeError:
            raise AdapterError("A generated binary contained a credential and was not published.")
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_bytes(raw)


def publish_outputs(run_dir, output, secret, details):
    architecture_file = run_dir / "global_memory/architecture.json"
    try:
        architecture = json.loads(architecture_file.read_text(encoding="utf8"))
    except (OSError, ValueError) as error:
        raise AdapterError("Crafter did not finish writing its architecture; no success marker was published.") from error
    files, actual = verify_codebase(run_dir / "codebase", architecture)
    for relative, source in files:
        if any(part in EXCLUDED_PARTS or part.startswith(".") for part in relative.parts):
            continue
        _copy_protected(source, output / "codebase" / relative, secret)
    for name in ["architecture.json", "architecture_md.md", "paper_analysis.md", "goal_and_config.md", "review.md"]:
        source = run_dir / "global_memory" / name
        if source.is_file() and not source.is_symlink() and source.stat().st_nlink == 1:
            _copy_protected(source, output / "planning" / name, secret)
    manifest = {"adapter": "ptc_agent_merged", "generated_files": actual,
                "scientific_correctness_verified": False, "pricing": "unknown",
                "estimated_cost_usd": None, **details}
    # The web server expects this only after real nonempty planned code exists.
    (output / "crafter-manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf8")
    return manifest


def run(args):
    root = repo_path(args.repo)
    locations = task_paths(require_output=True)
    work, output = locations["work"], locations["output"]
    secret = os.environ.get("CRAFTER_API_KEY") or os.environ.get("OPENAI_API_KEY", "")
    drop_credentials()
    model = os.environ.get("CRAFTER_MODEL", "").strip()
    base_url = os.environ.get("CRAFTER_BASE_URL", "").strip()
    if not model or not base_url:
        raise AdapterError("CRAFTER_MODEL and CRAFTER_BASE_URL are required.")
    endpoint = urlsplit(base_url)
    if endpoint.scheme not in {"http", "https"} or not endpoint.hostname or endpoint.username or endpoint.password or endpoint.query or endpoint.fragment:
        raise AdapterError("The model endpoint is invalid.")
    # vLLM may be intentionally configured without authentication. The SDK
    # requires a nonempty token; this placeholder remains only in memory.
    secret = secret or "local-no-credential"
    os.environ["CRAFTER_API_KEY"] = secret
    isolate_runtime(work)
    os.chdir(work)
    parsed = work / "parsed"
    content_file = parsed / "paper_content_list_v2.json"
    try:
        validate_content_list(json.loads(content_file.read_text(encoding="utf8")))
    except (OSError, ValueError) as error:
        raise AdapterError("Validated preprocessing output is unavailable; run preprocessing first.") from error
    sys.path.insert(0, str(root))
    llm = importlib.import_module("src.utils.llm_client")
    llm.BACKENDS["crafter-web"] = {"api_style": "openai", "model": model,
        "base_url": base_url, "api_key_env": "CRAFTER_API_KEY",
        "input_cost_per_1m": 0.0, "output_cost_per_1m": 0.0}
    llm.set_backend("crafter-web")
    from openai_bridge import install_openai_bridge
    install_openai_bridge(llm)
    protect_memory_writers(secret)
    protect_codegen_paths(work / "crafter-run/codebase", output, secret)
    main = importlib.import_module("src.main")
    original_resume = main._load_resumable_generated_file

    def safe_resume(base, name):
        relative = safe_relative(name)
        root_dir = Path(base).resolve()
        if root_dir not in root_dir.joinpath(*relative.parts).resolve().parents:
            raise AdapterError("Crafter resumable file path escaped its task codebase.")
        return original_resume(base, name)

    main._load_resumable_generated_file = safe_resume
    # Debug imports the subprocess module; wrapping its run entry also protects
    # git/pip helpers. Model calls stay in-process and retain the task credential.
    original_run = subprocess.run

    def child_run(*positional, **keywords):
        keywords["env"] = strip_credentials(keywords.get("env") or os.environ, secret)
        return original_run(*positional, **keywords)

    subprocess.run = child_run
    run_dir = work / "crafter-run"
    run_dir.mkdir(exist_ok=True)
    os.environ["PTC_TOKEN_USAGE_LOG"] = str(run_dir / "token_usage.jsonl")
    os.environ["PTC_TOKEN_USAGE_SUMMARY"] = str(run_dir / "token_usage_summary.json")
    os.environ["PTC_PAPER"] = os.environ.get("CRAFTER_TASK_ID", "web-task")
    previous_argv = sys.argv
    sys.argv = ["src.main", "--input", str(parsed), "--output", str(run_dir), "--no-vlm",
                "--debug-iterations", str(args.debug_iterations)]
    if args.skip_debug:
        sys.argv.append("--skip-debug")
    emit("crafter_start", model=model, figure_analysis=False, debug=not args.skip_debug,
         pricing="unknown; upstream zero-rate counters are not a billing estimate")
    completed = False
    try:
        main.main()
        finish_memory_writers()
        details = {"debug_enabled": not args.skip_debug, "figure_analysis_enabled": False,
                   "parser": json.loads((work / "preprocessing.json").read_text(encoding="utf8"))}
        manifest = publish_outputs(run_dir, output, secret, details)
        completed = True
        emit("crafter_complete", generated_file_count=len(manifest["generated_files"]), pricing="unknown")
    finally:
        sys.argv = previous_argv
        subprocess.run = original_run
        if not completed:
            # Safely finished original generation artifacts remain available as
            # partial outputs without creating the success manifest.
            try:
                finish_memory_writers()
                codebase = run_dir / "codebase"
                if codebase.is_dir() and not codebase.is_symlink():
                    for relative, source in safe_tree_files(codebase):
                        if not any(part in EXCLUDED_PARTS or part.startswith(".") for part in relative.parts):
                            _copy_protected(source, output / "codebase" / relative, secret)
            finally:
                os.environ.pop("CRAFTER_API_KEY", None)
                os.environ.pop("OPENAI_API_KEY", None)
        else:
            os.environ.pop("CRAFTER_API_KEY", None)
            os.environ.pop("OPENAI_API_KEY", None)


def check(args):
    drop_credentials()
    root = repo_path(args.repo)
    dependencies = {name: importlib.util.find_spec(name) is not None for name in
                    ["mineru", "openai", "anthropic", "yaml", "mcp", "aiohttp"]}
    compatible = False
    incompatibility = None
    if all(dependencies.values()):
        try:
            sys.path.insert(0, str(root))
            # Import the real checkout, never invoke its CLI/pipeline. Suppress
            # incidental import prints so the Node readiness probe gets one JSON.
            with redirect_stdout(io.StringIO()):
                main_module = importlib.import_module("src.main")
            parameters = inspect.signature(main_module.run_pipeline).parameters
            compatible = callable(main_module.main) and callable(main_module.run_pipeline) and all(
                name in parameters for name in ["input_path", "images_dir", "output_dir", "enable_vlm", "skip_debug"])
            compatible = compatible and callable(getattr(main_module, "_load_resumable_generated_file", None))
            if not compatible:
                incompatibility = "The checkout's entrypoint signature is incompatible with this adapter."
        except Exception as error:
            incompatibility = f"The checkout could not be imported ({type(error).__name__}); check its runtime dependencies."
    result = {"ready": all(dependencies.values()) and compatible, "repo": str(root), "entrypoint": "src.main:main",
              "dependencies": dependencies, "python": sys.version.split()[0],
              "parser": "mineru", "parser_models_verified": False,
              "capabilities": {"mineru": dependencies["mineru"], "parser_models_verified": False,
                "openai_compatible": True, "debug_tool_bridge": True, "figure_analysis": False,
                "model_requests_performed": False}, "entrypoint_compatible": compatible,
              "error": incompatibility, "limitations": PARSER_NOTICE}
    print(json.dumps(result, ensure_ascii=False), flush=True)
    if not result["ready"]:
        return 1
    return 0


def argument_parser():
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="action", required=True)
    for name in ["check", "preprocess", "run"]:
        sub = subparsers.add_parser(name)
        sub.add_argument("--repo")
        if name == "preprocess":
            sub.add_argument("--parser", choices=["mineru"], default="mineru")
            sub.add_argument("--mineru-backend", choices=["hybrid-auto-engine", "vlm-auto-engine", "hybrid-http-client", "vlm-http-client"], default="hybrid-auto-engine")
            sub.add_argument("--mineru-url")
            sub.add_argument("--mineru-source", choices=["huggingface", "modelscope", "local"])
        elif name == "run":
            sub.add_argument("--no-vlm", action="store_true", default=True)
            sub.add_argument("--skip-debug", action="store_true")
            sub.add_argument("--debug-iterations", type=int, default=20)
    return parser


def main(argv=None):
    args = argument_parser().parse_args(argv)
    secret = os.environ.get("CRAFTER_API_KEY") or os.environ.get("OPENAI_API_KEY", "") if args.action == "run" else ""
    try:
        if args.action == "check":
            return check(args)
        if args.action == "preprocess":
            preprocess(args)
        else:
            if args.debug_iterations < 1 or args.debug_iterations > 1000:
                raise AdapterError("--debug-iterations must be between 1 and 1000.")
            run(args)
        return 0
    except Exception as error:
        print(json.dumps({"event": "adapter_failed", "error": _redact(error, secret)}, ensure_ascii=False), file=sys.stderr, flush=True)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
