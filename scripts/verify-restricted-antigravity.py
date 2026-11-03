"""Check the installed AGY tool-filter implementation without authentication or inference.

Usage: python3 scripts/verify-restricted-antigravity.py [path/to/agy_acp_server.par]
Reads the shipped Python source and runs its real filter with the shipped enum inventory.
"""
import ast
import dataclasses
import enum
import glob
import logging
import os
import sys
import types
import zipfile
from collections.abc import Mapping
from typing import Any

candidates = glob.glob(os.path.expanduser("~/.agent-provider-kit/tools/antigravity-acp/*/versions/*/agy_acp_server.par"))
path = sys.argv[1] if len(sys.argv) > 1 else max(candidates, key=os.path.getmtime) if candidates else None
if not path:
    raise SystemExit("No installed Antigravity archive found; pass its path explicitly.")
archive = zipfile.ZipFile(path)
base = "google3/cloud/developer_experience/antigravity_extensions/acp_server/"
source = archive.read("google3/third_party/py/google/antigravity/types.py").decode()
node = next(n for n in ast.walk(ast.parse(source)) if isinstance(n, ast.ClassDef) and n.name == "BuiltinTools")
values = {n.targets[0].id: ast.literal_eval(n.value) for n in node.body if isinstance(n, ast.Assign) and isinstance(n.targets[0], ast.Name) and isinstance(n.value, ast.Constant) and isinstance(n.value.value, str)}
BuiltinTools = enum.Enum("BuiltinTools", values, type=str)
BuiltinTools.all_tools = classmethod(lambda cls: list(cls))
metadata = types.ModuleType("restricted_request_meta")
exec(archive.read(base + "request_meta.py"), metadata.__dict__)
module = types.ModuleType("restricted_native_filter")
sys.modules[module.__name__] = module
module.__dict__.update({"sdk_types_module": types.SimpleNamespace(BuiltinTools=BuiltinTools), "request_meta": metadata, "dataclasses": dataclasses, "logging": logging, "Mapping": Mapping, "Any": Any})
tree = ast.parse(archive.read(base + "tool_filter.py"))
tree.body = [n for n in tree.body if not isinstance(n, (ast.Import, ast.ImportFrom))]
exec(compile(tree, "native_tool_filter.py", "exec"), module.__dict__)
config = module.ToolFilterConfig.from_request_kwargs({"antigravity": {"enabledTools": []}})
assert config.resolve_disabled_builtins() == set(BuiltinTools), "Empty native allowlist did not disable every tool"
assert not module.ToolFilterConfig().resolve_disabled_builtins(), "Unset filter unexpectedly changes defaults"
for name in ["RUN_COMMAND", "VIEW_FILE", "CREATE_FILE", "EDIT_FILE", "INVOKE_SUBAGENT", "SEARCH_WEB"]:
    assert BuiltinTools[name] in config.resolve_disabled_builtins()
print(f"Antigravity native allowlist verified: all {len(values)} built-ins disabled, no model calls or credentials used.")
