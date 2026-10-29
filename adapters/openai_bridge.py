"""Transport compatibility for Crafter's existing Anthropic tool-call loop.

This module translates protocol envelopes only. Planning, tool definitions,
tool execution, and the debug loop remain in the original Crafter modules.
It performs no requests on import and never writes credentials to disk.
"""

from __future__ import annotations

import inspect
import json
import os
import re
from functools import wraps
from typing import Any


def _value(obj: Any, name: str, default: Any = None) -> Any:
    return obj.get(name, default) if isinstance(obj, dict) else getattr(obj, name, default)


def strip_provider_thinking(text: str) -> str:
    """Remove completed leading provider thinking envelopes, preserving content.

    Some OpenAI-compatible providers include their thinking in ordinary content.
    Strip only complete prefix envelopes: literal tags later in generated code,
    incomplete envelopes, and whitespace in visible content remain unchanged.
    """
    leading_block = re.compile(r"\A[\s\ufeff]*<think>.*?</think>", re.IGNORECASE | re.DOTALL)
    while True:
        match = leading_block.match(text)
        if not match:
            return text
        text = text[match.end():]


def _string_content(content: Any) -> str:
    """Flatten text blocks; never send multipart text arrays to DeepSeek."""
    if content is None:
        return ""
    if isinstance(content, str):
        return content
    if not isinstance(content, list):
        raise ValueError("A chat message must contain text or supported content blocks.")
    parts = []
    for block in content:
        if isinstance(block, str):
            parts.append(block)
        elif isinstance(block, dict) and block.get("type") == "text":
            value = block.get("text", "")
            if not isinstance(value, str):
                raise ValueError("A text block must contain a string.")
            parts.append(value)
        elif isinstance(block, dict) and block.get("type") in ("thinking", "redacted_thinking"):
            # Provider-specific thinking signatures are not OpenAI content.
            continue
        else:
            raise ValueError("The text-only web adapter received an unsupported content block.")
    return "\n".join(parts)


def anthropic_tools_to_openai(tools: list[dict]) -> list[dict]:
    converted = []
    for tool in tools:
        if not isinstance(tool, dict):
            raise ValueError("Invalid tool definition.")
        # Permit already-converted definitions for adapter consumers and tests.
        if tool.get("type") == "function" and isinstance(tool.get("function"), dict):
            converted.append({"type": "function", "function": dict(tool["function"])})
            continue
        name = tool.get("name")
        schema = tool.get("input_schema")
        if not isinstance(name, str) or not name or not isinstance(schema, dict):
            raise ValueError("Tool definitions need a name and an input schema.")
        converted.append({
            "type": "function",
            "function": {
                "name": name,
                "description": tool.get("description", ""),
                "parameters": schema,
            },
        })
    return converted


def anthropic_to_openai_messages(messages: list[dict], system: str = "") -> list[dict]:
    """Preserve call IDs and tool results while emitting string-only content."""
    converted = []
    if system:
        converted.append({"role": "system", "content": _string_content(system)})
    for message in messages:
        role = message.get("role")
        if role not in ("system", "user", "assistant", "tool"):
            raise ValueError("Unsupported chat message role.")
        content = message.get("content", "")
        if role == "tool":
            call_id = message.get("tool_call_id")
            if not isinstance(call_id, str) or not call_id:
                raise ValueError("A tool result must reference its original call ID.")
            converted.append({"role": "tool", "tool_call_id": call_id, "content": _string_content(content)})
            continue
        if not isinstance(content, list):
            item = {"role": role, "content": _string_content(content)}
            if role == "assistant" and message.get("tool_calls"):
                item["tool_calls"] = message["tool_calls"]
            converted.append(item)
            continue

        text_blocks = []
        calls = []
        results = []
        for block in content:
            kind = block.get("type") if isinstance(block, dict) else None
            if kind == "tool_use":
                if role != "assistant":
                    raise ValueError("Tool calls must appear in assistant messages.")
                call_id, name = block.get("id"), block.get("name")
                arguments = block.get("input", {})
                if not isinstance(call_id, str) or not call_id or not isinstance(name, str) or not name or not isinstance(arguments, dict):
                    raise ValueError("Invalid assistant tool call.")
                calls.append({"id": call_id, "type": "function", "function": {
                    "name": name, "arguments": json.dumps(arguments, ensure_ascii=False),
                }})
            elif kind == "tool_result":
                if role != "user":
                    raise ValueError("Anthropic tool results must appear in user messages.")
                call_id = block.get("tool_use_id")
                if not isinstance(call_id, str) or not call_id:
                    raise ValueError("A tool result must reference its original call ID.")
                text = _string_content(block.get("content", ""))
                if block.get("is_error"):
                    text = "Tool error:\n" + text
                results.append({"role": "tool", "tool_call_id": call_id, "content": text})
            else:
                text_blocks.append(block)

        # OpenAI requires all results for the previous assistant tool_calls before
        # a subsequent user instruction. Anthropic combines both in one turn.
        converted.extend(results)
        text = _string_content(text_blocks)
        if text or calls or not results:
            item = {"role": role, "content": text}
            if calls:
                item["tool_calls"] = calls
            elif role == "assistant" and message.get("tool_calls"):
                item["tool_calls"] = message["tool_calls"]
            converted.append(item)
    return converted


def normalize_completion_kwargs(kwargs: dict) -> dict:
    """Use the newer token parameter only for GPT-5+ and o-series models."""
    normalized = dict(kwargs)
    model = str(normalized.get("model", "")).lower().rsplit("/", 1)[-1]
    newer_openai_model = re.match(r"^(?:gpt-(?:[5-9]|[1-9]\d+)(?:[.\-]|$)|o[1-9]\d*(?:[.\-]|$))", model)
    if newer_openai_model and "max_tokens" in normalized:
        previous = normalized.pop("max_tokens")
        normalized.setdefault("max_completion_tokens", previous)
    return normalized


def extract_tool_response(response: Any) -> tuple[str, list[dict], list[dict], str]:
    choices = _value(response, "choices", [])
    if not choices:
        raise ValueError("The model returned no response choices.")
    choice = choices[0]
    message = _value(choice, "message", {})
    text = _string_content(_value(message, "content", ""))
    finish = _value(choice, "finish_reason")
    tool_calls = []
    for call in _value(message, "tool_calls", []) or []:
        function = _value(call, "function", {})
        arguments = _value(function, "arguments", "{}")
        if isinstance(arguments, str):
            try:
                arguments = json.loads(arguments)
            except (TypeError, ValueError) as exc:
                if finish == "length":
                    # Let Crafter's existing max_tokens retry branch handle a
                    # truncated call; never execute an incomplete argument set.
                    continue
                raise ValueError("The model returned invalid JSON tool arguments.") from exc
        call_id, name = _value(call, "id"), _value(function, "name")
        if not isinstance(arguments, dict) or not isinstance(call_id, str) or not call_id or not isinstance(name, str) or not name:
            raise ValueError("The model returned an invalid tool call.")
        tool_calls.append({"id": call_id, "name": name, "input": arguments})
    stop_reason = {"tool_calls": "tool_use", "length": "max_tokens", "stop": "end_turn", "content_filter": "refusal"}.get(finish)
    if stop_reason is None:
        stop_reason = "tool_use" if tool_calls else "end_turn"
    return text, tool_calls, [], stop_reason


class _CompletionProxy:
    def __init__(self, completion: Any):
        self._completion = completion

    async def create(self, **kwargs: Any) -> Any:
        return await self._completion.create(**normalize_completion_kwargs(kwargs))

    def __getattr__(self, name: str) -> Any:
        return getattr(self._completion, name)


class _ChatProxy:
    def __init__(self, chat: Any):
        self._chat = chat
        self.completions = _CompletionProxy(chat.completions)

    def __getattr__(self, name: str) -> Any:
        return getattr(self._chat, name)


def compatible_client_class(original: Any) -> type:
    """Wrap the SDK rather than changing the generation algorithm."""
    class CompatibleAsyncOpenAI:
        def __init__(self, *args: Any, **kwargs: Any):
            self._client = original(*args, **kwargs)
            self.chat = _ChatProxy(self._client.chat)

        def __getattr__(self, name: str) -> Any:
            return getattr(self._client, name)

        async def __aenter__(self) -> Any:
            await self._client.__aenter__()
            return self

        async def __aexit__(self, *args: Any) -> Any:
            return await self._client.__aexit__(*args)

    return CompatibleAsyncOpenAI


def install_openai_bridge(llm_module: Any) -> None:
    """Install before importing src.main, whose DebugAgent binds tool calls."""
    if getattr(llm_module, "_crafter_web_bridge_installed", False):
        return
    llm_module.AsyncOpenAI = compatible_client_class(llm_module.AsyncOpenAI)
    original_plain_call = getattr(llm_module, "_call_openai", None)
    if callable(original_plain_call):
        @wraps(original_plain_call)
        async def visible_plain_call(*args: Any, **kwargs: Any) -> str:
            # Await the entire original continuation loop first. Its internal
            # assistant history must retain the exact provider response text.
            result = await original_plain_call(*args, **kwargs)
            return strip_provider_thinking(result)

        llm_module._call_openai = visible_plain_call

    async def call_minimax_with_tools(
        messages: list[dict], tools: list[dict], system: str = "",
        max_tokens: int = 4096, temperature: float = 0.7,
        stage: str = "unknown", cache: bool = False,
    ) -> tuple[str, list[dict], list[dict], str]:
        cfg = llm_module.BACKENDS[llm_module._current_backend]
        if cfg.get("api_style") != "openai":
            raise RuntimeError("The web transport bridge requires an OpenAI-compatible backend.")
        client_kwargs = {"api_key": os.environ[cfg["api_key_env"]]}
        if cfg.get("base_url"):
            client_kwargs["base_url"] = cfg["base_url"]
        client = llm_module.AsyncOpenAI(**client_kwargs)
        try:
            limit = cfg.get("max_tokens_limit")
            request = {
                "model": cfg["model"],
                "messages": anthropic_to_openai_messages(messages, system),
                "max_tokens": min(max_tokens, limit) if limit else max_tokens,
                "temperature": temperature,
            }
            if tools:
                request["tools"] = anthropic_tools_to_openai(tools)
            response = await client.chat.completions.create(**request)
            result = extract_tool_response(response)
            llm_module._track_api_response(
                response, stage=stage, call_kind="openai_tools",
                requested_model=cfg["model"], pricing_backend=llm_module._current_backend,
                stop_reason=_value(_value(response, "choices", [{}])[0], "finish_reason"),
            )
            return result
        finally:
            closer = getattr(client, "close", None)
            if closer:
                closing = closer()
                if inspect.isawaitable(closing):
                    await closing

    llm_module.call_minimax_with_tools = call_minimax_with_tools
    llm_module._crafter_web_bridge_installed = True
