#!/usr/bin/env python3
"""Validate Athena Character Responses and continuous-conversation contracts."""

import json
import hashlib
import sys
from pathlib import Path

from jsonschema import Draft202012Validator


REPO_ROOT = Path(__file__).resolve().parents[1]
SCHEMA_ROOT = REPO_ROOT / "docs" / "schemas"
CONTRACTS = (
    {
        "version": "v1",
        "expected": 10,
        "response": SCHEMA_ROOT / "athena-character-responses-v1.schema.json",
        "manifest": SCHEMA_ROOT
        / "athena-character-capability-manifest-v1.schema.json",
    },
    {
        "version": "v2",
        "expected": 8,
        "response": SCHEMA_ROOT / "athena-character-responses-v2.schema.json",
        "manifest": SCHEMA_ROOT
        / "athena-character-capability-manifest-v2.schema.json",
    },
)

EXTRA_SCHEMAS = (
    "athena-3d-center-frame-v1.schema.json",
    "athena-3d-center-incremental-responses-v1.schema.json",
    "athena-3d-center-long-term-character-memory-v1.schema.json",
    "athena-3d-center-character-memory-v2.schema.json",
    "athena-3d-session-memory-v1.schema.json",
)


def load_json(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


def canonical_digest(value: dict) -> str:
    return hashlib.sha256(
        json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
    ).hexdigest()


def validate_v2_links(fixture_root: Path, manifest: dict) -> list[str]:
    errors = []
    expected_ref = {
        "id": manifest.get("id"),
        "version": manifest.get("version"),
        "sha256": manifest.get("integrity", {}).get("sha256"),
    }
    capabilities = {
        entry.get("id"): entry for entry in manifest.get("capabilities", [])
    }
    for path in sorted(fixture_root.glob("0[1-5]-*-response.json")):
        response = load_json(path)
        if response.get("capability_manifest") != expected_ref:
            errors.append(f"{path.name}: top-level Manifest reference mismatch")
        if response.get("character", {}).get("capability_manifest") != expected_ref:
            errors.append(f"{path.name}: character Manifest reference mismatch")
        for track in response.get("output", [{}, {}])[1].get("tracks", []):
            for cue in track.get("cues", []):
                ids = []
                if track.get("name") == "face":
                    ids.extend(change.get("state") for change in cue.get("changes", []))
                else:
                    ids.extend(
                        value
                        for value in (
                            cue.get("gaze"),
                            cue.get("motion"),
                            cue.get("action"),
                            cue.get("delivery", {}).get("style"),
                        )
                        if value
                    )
                for capability_id in ids:
                    if capability_id not in capabilities:
                        errors.append(
                            f"{path.name}: unknown capability {capability_id}"
                        )
                if track.get("name") == "action" and cue.get("action") in capabilities:
                    parameter_schema = capabilities[cue["action"]].get("parameters", {})
                    parameter_errors = list(
                        Draft202012Validator(parameter_schema).iter_errors(
                            cue.get("arguments", {})
                        )
                    )
                    errors.extend(
                        f"{path.name}: action {cue['cue_id']} {error.message}"
                        for error in parameter_errors
                    )
    return errors


def main() -> int:
    failed = False
    fixture_count = 0
    for name in EXTRA_SCHEMAS:
        schema_path = SCHEMA_ROOT / name
        schema = load_json(schema_path)
        Draft202012Validator.check_schema(schema)
        print(f"PASS {schema_path.relative_to(REPO_ROOT)}")
    for contract in CONTRACTS:
        response_schema = load_json(contract["response"])
        manifest_schema = load_json(contract["manifest"])
        Draft202012Validator.check_schema(response_schema)
        Draft202012Validator.check_schema(manifest_schema)
        fixture_root = (
            REPO_ROOT
            / "docs"
            / "examples"
            / "character-responses"
            / contract["version"]
        )
        fixture_paths = sorted(fixture_root.glob("*.json"))
        if len(fixture_paths) != contract["expected"]:
            print(
                f"Expected {contract['expected']} {contract['version']} fixtures, "
                f"found {len(fixture_paths)}.",
                file=sys.stderr,
            )
            failed = True
            continue
        fixture_count += len(fixture_paths)
        for path in fixture_paths:
            schema = (
                manifest_schema if path.name.startswith("06-") else response_schema
            )
            errors = sorted(
                Draft202012Validator(schema).iter_errors(load_json(path)),
                key=lambda error: list(error.absolute_path),
            )
            if not errors:
                print(f"PASS {path.relative_to(REPO_ROOT)}")
                continue
            failed = True
            print(f"FAIL {path.relative_to(REPO_ROOT)}", file=sys.stderr)
            for error in errors:
                location = "/".join(str(part) for part in error.absolute_path) or "$"
                print(f"  {location}: {error.message}", file=sys.stderr)
        if contract["version"] == "v2":
            link_errors = validate_v2_links(
                fixture_root,
                load_json(fixture_root / "06-capability-manifest.json"),
            )
            if link_errors:
                failed = True
                for error in link_errors:
                    print(f"FAIL v2 linked contract: {error}", file=sys.stderr)
            else:
                print("PASS v2 Manifest references, capabilities, and Action parameters")

    conversation_schema_path = (
        SCHEMA_ROOT / "athena-character-conversations-v2.schema.json"
    )
    conversation_schema = load_json(conversation_schema_path)
    Draft202012Validator.check_schema(conversation_schema)
    conversation_root = (
        REPO_ROOT / "docs" / "examples" / "character-conversations" / "v2"
    )
    conversation_paths = sorted(conversation_root.glob("*.json"))
    if len(conversation_paths) != 5:
        print(
            f"Expected 5 Character Conversation fixtures, found {len(conversation_paths)}.",
            file=sys.stderr,
        )
        failed = True
    for path in conversation_paths:
        errors = sorted(
            Draft202012Validator(conversation_schema).iter_errors(load_json(path)),
            key=lambda error: list(error.absolute_path),
        )
        if not errors:
            print(f"PASS {path.relative_to(REPO_ROOT)}")
            continue
        failed = True
        print(f"FAIL {path.relative_to(REPO_ROOT)}", file=sys.stderr)
        for error in errors:
            location = "/".join(str(part) for part in error.absolute_path) or "$"
            print(f"  {location}: {error.message}", file=sys.stderr)

    performance_pack_schema = load_json(
        SCHEMA_ROOT / "athena-character-performance-pack-v1.schema.json"
    )
    performance_plan_schema = load_json(
        SCHEMA_ROOT / "athena-character-performance-plan-v1.schema.json"
    )
    Draft202012Validator.check_schema(performance_pack_schema)
    Draft202012Validator.check_schema(performance_plan_schema)
    performance_documents = (
        (
            REPO_ROOT / "server" / "character-performance-packs" / "mock-anatomy-v1.json",
            performance_pack_schema,
            "pack",
        ),
        (
            REPO_ROOT / "docs" / "examples" / "character-performance" / "v1" / "01-thirteen-track-compiled-plan.json",
            performance_plan_schema,
            "plan",
        ),
    )
    expected_tracks = [
        "face", "gaze", "head_neck", "shoulders", "torso", "left_arm",
        "right_arm", "left_hand", "right_hand", "left_leg", "right_leg",
        "action", "speech",
    ]
    for path, schema, kind in performance_documents:
        document = load_json(path)
        errors = list(Draft202012Validator(schema).iter_errors(document))
        if kind == "pack":
            digest_source = json.loads(json.dumps(document))
            observed = digest_source["integrity"].pop("sha256")
            digest_source["integrity"].pop("signature", None)
            expected = canonical_digest(digest_source)
            if observed != expected:
                errors.append(Exception(f"Pack digest mismatch: {observed} != {expected}"))
            tracks = [entry["track"] for entry in document["track_support"]]
        else:
            digest_source = json.loads(json.dumps(document))
            observed = digest_source.pop("integrity")["sha256"]
            expected = canonical_digest(digest_source)
            if observed != expected:
                errors.append(Exception(f"Plan digest mismatch: {observed} != {expected}"))
            tracks = list(dict.fromkeys(command["track"] for command in document["commands"]))
        if tracks != expected_tracks:
            errors.append(Exception(f"13-track order mismatch: {tracks}"))
        if errors:
            failed = True
            print(f"FAIL {path.relative_to(REPO_ROOT)}", file=sys.stderr)
            for error in errors:
                print(f"  {getattr(error, 'message', str(error))}", file=sys.stderr)
        else:
            print(f"PASS {path.relative_to(REPO_ROOT)}")

    center_schema = load_json(
        SCHEMA_ROOT / "athena-3d-center-frame-v1.schema.json"
    )
    Draft202012Validator.check_schema(center_schema)
    center_fixture_path = (
        REPO_ROOT
        / "docs"
        / "examples"
        / "athena-3d-center"
        / "v1"
        / "01-simultaneous-turn-frame.json"
    )
    center_fixture = load_json(center_fixture_path)
    center_errors = list(
        Draft202012Validator(center_schema).iter_errors(center_fixture)
    )
    modules = center_fixture["timeline"]["time_blocks"][0]["modules"]
    if not modules["gaze"] or not modules["speech"]:
        center_errors.append(
            Exception("3D Center fixture must demonstrate simultaneous gaze and speech")
        )
    if center_errors:
        failed = True
        print(f"FAIL {center_fixture_path.relative_to(REPO_ROOT)}", file=sys.stderr)
        for error in center_errors:
            print(f"  {getattr(error, 'message', str(error))}", file=sys.stderr)
    else:
        print(f"PASS {center_fixture_path.relative_to(REPO_ROOT)}")

    incremental_schema = load_json(
        SCHEMA_ROOT / "athena-3d-center-incremental-responses-v1.schema.json"
    )
    incremental_paths = sorted(
        (
            REPO_ROOT
            / "docs"
            / "examples"
            / "athena-3d-center"
            / "incremental"
            / "v1"
        ).glob("*.json")
    )
    if len(incremental_paths) != 2:
        print(
            f"Expected 2 Incremental Response fixtures, found {len(incremental_paths)}.",
            file=sys.stderr,
        )
        failed = True
    for path in incremental_paths:
        errors = list(
            Draft202012Validator(incremental_schema).iter_errors(load_json(path))
        )
        if errors:
            failed = True
            print(f"FAIL {path.relative_to(REPO_ROOT)}", file=sys.stderr)
            for error in errors:
                location = "/".join(str(part) for part in error.absolute_path) or "$"
                print(f"  {location}: {error.message}", file=sys.stderr)
        else:
            print(f"PASS {path.relative_to(REPO_ROOT)}")

    if failed:
        return 1
    print(
        "Character Responses and 3D Center contract validation passed "
        f"(13 schemas, {fixture_count + len(conversation_paths) + 5} fixtures across "
        "v1/v2/performance/3d-center/session-memory/character-memory)."
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
