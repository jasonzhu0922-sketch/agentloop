"""Build the native single-choice HIL request from the live scenario directory."""


def selection_requirement(scenarios, evidence_ref):
    if not scenarios:
        raise ValueError("No configured data scenarios are available")
    options = []
    seen = set()
    for scenario in scenarios:
        identifier, name = scenario["id"], scenario["name"]
        if (not isinstance(identifier, str) or not identifier.strip()
                or identifier in seen or not isinstance(name, str) or not name.strip()):
            raise ValueError("Scenario directory contains invalid or duplicate identities")
        seen.add(identifier)
        options.append({"id": identifier, "label": name,
                        "description": scenario.get("description") or "",
                        "identityRefs": ["data-analysis:scenario:" + identifier]})
    return {"schema": "agentloop.humanLoopRequirement/v1", "humanLoopRequirement": {
        "kind": "selection", "title": "选择数据场景",
        "prompt": "请选择本次查询或分析使用的数据场景。",
        "rationale": "本次任务尚未由用户明确指定数据场景；必须由用户选择后才能读取场景元数据和执行 SQL。",
        "evidenceRefs": [evidence_ref],
        "responseSchema": {"type": "select", "minSelections": 1, "maxSelections": 1, "options": options},
        "resume": {"mode": "continue_step"},
    }}
