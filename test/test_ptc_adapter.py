"""Offline adapter checks with mocked native MinerU output; no real parsing/model runs."""
import asyncio
from contextlib import redirect_stdout
import importlib
import io
import json
import os
from pathlib import Path
import sys
import tempfile
import threading
import time
from functools import wraps
from types import SimpleNamespace
import unittest
from unittest.mock import patch

PROJECT = Path(__file__).resolve().parents[1]
CRAFTER_REPO = Path(os.environ.get('PTC_TEST_REPO', str(Path.home() / 'GitHub' / 'ptc_agent_merged'))).expanduser().resolve()
sys.path.insert(0, str(PROJECT / "adapters"))
import ptc_adapter as adapter
import openai_bridge as bridge


NATIVE_CONTENT = [[
    {'type': 'title', 'content': {'level': 1, 'title_content': [{'type': 'text', 'content': '1 Introduction'}]}},
    {'type': 'paragraph', 'content': {'paragraph_content': [{'type': 'text', 'content': 'Reliable paper text.'}]}},
    {'type': 'title', 'content': {'level': 1, 'title_content': [{'type': 'text', 'content': '2 Methods'}]}},
    {'type': 'image', 'content': {'image_source': {'path': 'images/figure.png'},
                                'image_caption': [{'type': 'text', 'content': 'Algorithm diagram'}]}},
]]


class AdapterTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='crafter-python-adapter-')
        self.root = Path(self.temporary.name)
        self.work, self.output = self.root / 'work', self.root / 'outputs'
        self.work.mkdir()
        self.output.mkdir()
        self.pdf = self.root / 'input.pdf'
        # The subprocess is mocked; this is an opaque retained-input fixture.
        self.pdf.write_bytes(b'%PDF-1.4\nmocked native parser input\n%%EOF')
        self.old_cwd = Path.cwd()
        self.environment = patch.dict(os.environ, {'CRAFTER_INPUT': str(self.pdf), 'CRAFTER_WORK': str(self.work),
                                                  'CRAFTER_OUTPUT': str(self.output), 'CRAFTER_API_KEY': 'must-not-reach-parser'}, clear=True)
        self.environment.start()

    def tearDown(self):
        os.chdir(self.old_cwd)
        self.environment.stop()
        self.temporary.cleanup()

    def preprocess(self, runner):
        args = adapter.argument_parser().parse_args(['preprocess'])
        with patch.object(adapter.subprocess, 'run', side_effect=runner), redirect_stdout(io.StringIO()):
            adapter.preprocess(args)
        return json.loads((self.work / 'parsed/paper_content_list_v2.json').read_text())

    def native_parser(self, command, **kwargs):
        self.assertEqual(command[:4], [sys.executable, '-B', '-m', 'mineru.cli.client'])
        self.assertEqual(Path(command[command.index('-p') + 1]), self.pdf.resolve())
        self.assertNotIn('CRAFTER_API_KEY', kwargs['env'])
        folder = Path(command[command.index('-o') + 1]) / 'input/hybrid_auto'
        folder.mkdir(parents=True)
        (folder / 'input_content_list_v2.json').write_text(json.dumps(NATIVE_CONTENT))
        (folder / 'images').mkdir()
        (folder / 'images/figure.png').write_bytes(b'\x89PNG\r\nmock image artifact')
        return SimpleNamespace(returncode=0)

    def test_native_mineru_artifacts_feed_real_partition_and_drop_credentials(self):
        content = self.preprocess(self.native_parser)
        self.assertIsInstance(content[0], list)
        self.assertEqual(content[0][0]['type'], 'title')
        self.assertEqual(content[0][1]['content']['paragraph_content'][0]['content'], 'Reliable paper text.')
        self.assertNotIn('CRAFTER_API_KEY', os.environ)
        self.assertEqual((self.work / 'parsed/images/figure.png').read_bytes(), b'\x89PNG\r\nmock image artifact')
        details = json.loads((self.work / 'preprocessing.json').read_text())
        self.assertEqual(details['parser'], 'mineru')
        self.assertEqual(details['backend'], 'hybrid-auto-engine')

        repo = CRAFTER_REPO
        if not (repo / 'src/agents/partition_agent.py').is_file():
            self.skipTest('Real Crafter checkout is unavailable for the PartitionAgent integration assertion.')
        sys.path.insert(0, str(repo))
        from src.agents.partition_agent import PartitionAgent
        from src.memory.global_memory import GlobalMemory
        memory = GlobalMemory(str(self.work / 'partition-memory'))
        agent = PartitionAgent(memory, str(self.work / 'parsed/paper_content_list_v2.json'), str(self.work / 'partition-output'))
        result = asyncio.run(agent.run())
        adapter.finish_memory_writers()
        self.assertEqual([section['title'] for section in result['sections']], ['1 Introduction', '2 Methods'])
        self.assertEqual(result['images'][0]['path'], 'images/figure.png')

    def test_mineru_failure_and_zero_exit_without_output_never_fall_back(self):
        with self.assertRaisesRegex(adapter.AdapterError, 'exited with code 3'):
            self.preprocess(lambda *args, **kwargs: SimpleNamespace(returncode=3))
        with self.assertRaisesRegex(adapter.AdapterError, 'exactly one v2'):
            self.preprocess(lambda *args, **kwargs: SimpleNamespace(returncode=0))
        self.assertFalse((self.work / 'parsed/paper_content_list_v2.json').exists())

    def test_mineru_zero_exit_with_invalid_v2_content_is_rejected(self):
        def malformed(command, **kwargs):
            folder = Path(command[command.index('-o') + 1]) / 'input/hybrid_auto'
            folder.mkdir(parents=True)
            (folder / 'input_content_list_v2.json').write_text('not JSON')
            return SimpleNamespace(returncode=0)

        with self.assertRaisesRegex(adapter.AdapterError, 'invalid JSON'):
            self.preprocess(malformed)
        self.assertFalse((self.work / 'parsed/paper_content_list_v2.json').exists())

    def test_v1_content_and_generated_path_traversal_are_rejected(self):
        with self.assertRaisesRegex(adapter.AdapterError, 'nested page/item'):
            adapter.validate_content_list([{'type': 'text', 'text': 'v1 is incompatible'}])
        for path in ['../outside.py', '/absolute.py', 'nested/../../outside.py', 'a\\b.py']:
            with self.assertRaises(adapter.AdapterError):
                adapter.safe_relative(path)

    def test_success_requires_real_planned_code_and_publication_excludes_private_memory(self):
        run = self.work / 'crafter-run'
        code = run / 'codebase'
        memory = run / 'global_memory'
        code.mkdir(parents=True)
        memory.mkdir()
        (run / 'local_memory').mkdir()
        (run / 'local_memory/private.json').write_text('private conversation')
        (memory / 'partitions.json').write_text('private preprocessing content')
        (code / 'reproduce.sh').write_text('#!/bin/sh\npython main.py\n')
        (code / 'requirements.txt').write_text('numpy\n')
        (memory / 'architecture.json').write_text(json.dumps({'files': []}))
        with self.assertRaisesRegex(adapter.AdapterError, 'no architecture'):
            adapter.publish_outputs(run, self.output, '', {})
        self.assertFalse((self.output / 'crafter-manifest.json').exists())
        (code / 'README.md').write_text('Documentation alone is not generated code.')
        (memory / 'architecture.json').write_text(json.dumps({'files': [{'path': 'README.md'}]}))
        with self.assertRaisesRegex(adapter.AdapterError, 'nonempty planned implementation'):
            adapter.publish_outputs(run, self.output, '', {})
        (code / 'main.py').write_text('print("secret-for-protection-check")\n')
        (memory / 'architecture.json').write_text(json.dumps({'files': [{'path': 'main.py'}]}))
        manifest = adapter.publish_outputs(run, self.output, 'secret-for-protection-check', {'debug_enabled': True})
        self.assertEqual(manifest['generated_files'], ['main.py'])
        self.assertIsNone(manifest['estimated_cost_usd'])
        self.assertEqual(manifest['pricing'], 'unknown')
        self.assertNotIn('secret-for-protection-check', (self.output / 'codebase/main.py').read_text())
        self.assertFalse((self.output / 'local_memory').exists())
        self.assertFalse((self.output / 'planning/partitions.json').exists())

    def test_symlink_or_missing_planned_output_cannot_publish_success(self):
        code = self.work / 'codebase'
        code.mkdir()
        (code / 'requirements.txt').write_text('')
        (code / 'reproduce.sh').write_text('echo ready')
        with self.assertRaisesRegex(adapter.AdapterError, 'missing'):
            adapter.verify_codebase(code, {'files': [{'path': 'main.py'}]})
        outside = self.root / 'outside.py'
        outside.write_text('print("outside")')
        (code / 'main.py').symlink_to(outside)
        with self.assertRaisesRegex(adapter.AdapterError, 'symbolic link'):
            adapter.verify_codebase(code, {'files': [{'path': 'main.py'}]})

    def test_generated_child_environment_removes_all_provider_credentials(self):
        clean = adapter.strip_credentials({'PATH': '/bin', 'CRAFTER_API_KEY': 'key',
                                          'ANTHROPIC_API_KEY': 'other', 'CUSTOM_AUTH': 'my-key',
                                          'CRAFTER_WORK': '/work'}, 'my-key')
        self.assertEqual(clean, {'PATH': '/bin', 'CRAFTER_WORK': '/work'})

    def test_readiness_imports_actual_entrypoint_without_model_requests(self):
        repo = CRAFTER_REPO
        if not (repo / 'src/main.py').is_file():
            self.skipTest('Real Crafter checkout is unavailable.')
        captured = io.StringIO()
        with redirect_stdout(captured):
            status = adapter.check(SimpleNamespace(repo=str(repo)))
        result = json.loads(captured.getvalue())
        self.assertEqual(status, 0)
        self.assertTrue(result['ready'])
        self.assertTrue(result['entrypoint_compatible'])
        self.assertTrue(result['dependencies']['mineru'])
        self.assertTrue(result['capabilities']['mineru'])
        self.assertEqual(result['parser'], 'mineru')
        self.assertFalse(result['parser_models_verified'])
        self.assertFalse(result['capabilities']['model_requests_performed'])
        self.assertNotIn('CRAFTER_API_KEY', os.environ)

    def test_wrapped_memory_writers_are_joined_and_redact_before_disk_write(self):
        repo = CRAFTER_REPO
        if not (repo / 'src/memory/global_memory.py').is_file():
            self.skipTest('Real Crafter checkout is unavailable.')
        sys.path.insert(0, str(repo))
        from src.memory.global_memory import GlobalMemory
        from src.memory.local_memory import LocalMemory
        global_original, local_original = GlobalMemory._write_file, LocalMemory._write_to_disk
        before = set(threading.enumerate())

        @wraps(global_original)
        def delayed_global(self, *args):
            time.sleep(0.08)
            return global_original(self, *args)

        @wraps(local_original)
        def delayed_local(self, *args):
            time.sleep(0.08)
            return local_original(self, *args)

        GlobalMemory._write_file, LocalMemory._write_to_disk = delayed_global, delayed_local
        try:
            adapter.protect_memory_writers('raw-task-secret')
            global_memory = GlobalMemory(str(self.work / 'global-memory'))
            local_memory = LocalMemory('test-agent', str(self.work))
            global_memory.set('test', {'value': 'raw-task-secret'})
            local_memory.add_message('assistant', 'raw-task-secret')
            adapter.finish_memory_writers(timeout=2)
            global_text = (self.work / 'global-memory/test.json').read_text()
            local_text = (self.work / 'local_memory/test-agent.json').read_text()
            self.assertNotIn('raw-task-secret', global_text)
            self.assertNotIn('raw-task-secret', local_text)
            self.assertIn('[REDACTED]', global_text)
            self.assertIn('[REDACTED]', local_text)
        finally:
            for thread in set(threading.enumerate()) - before:
                thread.join(2)
            GlobalMemory._write_file, LocalMemory._write_to_disk = global_original, local_original

    def test_completed_codegen_file_is_copied_before_pipeline_finishes(self):
        repo = CRAFTER_REPO
        if not (repo / 'src/agents/codegen_agent.py').is_file():
            self.skipTest('Real Crafter checkout is unavailable.')
        sys.path.insert(0, str(repo))
        from src.agents.codegen_agent import CodegenAgent
        original = CodegenAgent.run
        codebase = self.work / 'crafter-run/codebase'
        codebase.mkdir(parents=True)

        async def generate_one_file(self):
            (Path(self.codebase_dir) / self.file_path).write_text('print("finished file")\n')
            return {'file_path': self.file_path}

        CodegenAgent.run = generate_one_file
        try:
            adapter.protect_codegen_paths(codebase, self.output)
            result = asyncio.run(CodegenAgent.run(SimpleNamespace(codebase_dir=codebase, file_path='main.py')))
            self.assertEqual(result['file_path'], 'main.py')
            self.assertEqual((self.output / 'codebase/main.py').read_text(), 'print("finished file")\n')
            self.assertFalse((self.output / 'crafter-manifest.json').exists())
        finally:
            CodegenAgent.run = original


class BridgeTests(unittest.TestCase):
    def test_plain_response_strips_only_leading_thinking_after_original_finishes(self):
        thought = '<think>Misleading JSON: {"wrong":true}\n```python\nraise RuntimeError()\n```</think>\n'
        visible = '{"correct":true}'
        history = []

        async def original(*args, **kwargs):
            history.append({'role': 'assistant', 'content': thought + visible})
            return thought + visible

        llm = SimpleNamespace(AsyncOpenAI=object, _call_openai=original)
        bridge.install_openai_bridge(llm)
        self.assertEqual(asyncio.run(llm._call_openai()).lstrip(), visible)
        self.assertEqual(history[0]['content'], thought + visible)
        self.assertIs(llm._call_openai.__wrapped__, original)
        source = '```python\ntext = "<think>literal visible tags</think>"\n```'
        self.assertEqual(bridge.strip_provider_thinking(source), source)
        self.assertEqual(bridge.strip_provider_thinking('<think>unfinished'), '<think>unfinished')
        tool_response = {'choices': [{'finish_reason': 'stop', 'message': {'content': thought + visible}}]}
        self.assertEqual(bridge.extract_tool_response(tool_response)[0], thought + visible)

    def test_anthropic_tool_roundtrip_is_string_only_and_keeps_thinking_text(self):
        content = '<think>Keep the complete assistant content.</think>Inspect the file.'
        messages = [
            {'role': 'user', 'content': 'Fix the error.'},
            {'role': 'assistant', 'content': [{'type': 'text', 'text': content},
                                            {'type': 'tool_use', 'id': 'call-1', 'name': 'read_file', 'input': {'path': 'main.py'}}]},
            {'role': 'user', 'content': [{'type': 'tool_result', 'tool_use_id': 'call-1', 'content': [{'type': 'text', 'text': 'file contents'}]},
                                       {'type': 'text', 'text': 'Continue.'}]},
        ]
        converted = bridge.anthropic_to_openai_messages(messages, 'System instructions')
        self.assertTrue(all(isinstance(message['content'], str) for message in converted))
        self.assertEqual(converted[2]['content'], content)
        self.assertEqual(converted[2]['tool_calls'][0]['id'], 'call-1')
        self.assertEqual(converted[3], {'role': 'tool', 'tool_call_id': 'call-1', 'content': 'file contents'})
        self.assertEqual(converted[4]['role'], 'user')
        tool = bridge.anthropic_tools_to_openai([{'name': 'read_file', 'description': 'Read a file', 'input_schema': {'type': 'object'}}])[0]
        self.assertEqual(tool['function']['parameters'], {'type': 'object'})

    def test_token_parameter_mapping_and_truncated_tool_arguments(self):
        for model in ['gpt-5-nano', 'gpt-6.1', 'o3-mini']:
            converted = bridge.normalize_completion_kwargs({'model': model, 'max_tokens': 100})
            self.assertEqual(converted['max_completion_tokens'], 100)
            self.assertNotIn('max_tokens', converted)
        self.assertEqual(bridge.normalize_completion_kwargs({'model': 'Qwen3-32B', 'max_tokens': 100})['max_tokens'], 100)
        response = {'choices': [{'finish_reason': 'length', 'message': {'content': '', 'tool_calls': [
            {'id': 'call-1', 'function': {'name': 'read_file', 'arguments': '{"path":'}}]}}]}
        self.assertEqual(bridge.extract_tool_response(response), ('', [], [], 'max_tokens'))

    def test_installed_tool_bridge_uses_fake_client_and_existing_usage_tracker(self):
        captured, tracked = [], []

        class FakeClient:
            def __init__(self, **kwargs):
                self.chat = SimpleNamespace(completions=SimpleNamespace(create=self.create))

            async def create(self, **kwargs):
                captured.append(kwargs)
                return {'choices': [{'finish_reason': 'tool_calls', 'message': {'content': 'Inspecting', 'tool_calls': [
                    {'id': 'call-1', 'function': {'name': 'read_file', 'arguments': '{"path":"main.py"}'}}]}}]}

            async def close(self):
                pass

        llm = SimpleNamespace(AsyncOpenAI=FakeClient, _current_backend='crafter-web',
                              BACKENDS={'crafter-web': {'api_style': 'openai', 'model': 'gpt-5-nano',
                                                       'api_key_env': 'CRAFTER_API_KEY', 'base_url': 'https://fixture.invalid/v1'}},
                              _track_api_response=lambda *args, **kwargs: tracked.append(kwargs))
        bridge.install_openai_bridge(llm)
        with patch.dict(os.environ, {'CRAFTER_API_KEY': 'fake-only-memory'}):
            result = asyncio.run(llm.call_minimax_with_tools([{'role': 'user', 'content': 'Inspect'}],
                                                            [{'name': 'read_file', 'input_schema': {'type': 'object'}}]))
        self.assertEqual(result[1], [{'id': 'call-1', 'name': 'read_file', 'input': {'path': 'main.py'}}])
        self.assertEqual(result[3], 'tool_use')
        self.assertIn('max_completion_tokens', captured[0])
        self.assertEqual(tracked[0]['call_kind'], 'openai_tools')


if __name__ == '__main__':
    unittest.main()
