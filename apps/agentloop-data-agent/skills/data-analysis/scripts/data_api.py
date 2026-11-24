#!/usr/bin/env python3
"""Optional Skill-owned HTTP interface; shares the CLI's deterministic adapter."""
from __future__ import annotations

import argparse
import sys
sys.dont_write_bytecode = True
from typing import Annotated

from fastapi import FastAPI, HTTPException, Query
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field

from data_access import load_gateway
from entity_binding import EntityBindingError
from semantic_retrieval import METADATA_ACTIONS, KnowledgeRequestError


class SqlRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True, allow_inf_nan=False)
    scenario_id: str = Field(min_length=1, max_length=200, pattern=r"^\S+$")
    sql: str = Field(min_length=1, max_length=65536)
    params: list[str | int | float | bool | None] = Field(default_factory=list, max_length=1000)
    query_plan: dict | None = None


class EntityRequest(BaseModel):
    model_config = ConfigDict(extra='forbid', strict=True)
    scenario_id: str = Field(min_length=1, max_length=200, pattern=r'^\S+$')
    mention: str = Field(min_length=1, max_length=1000)
    matched_term: str | None = None
    canonical_name: str = Field(min_length=1, max_length=1000)
    source_id: str = Field(min_length=1, max_length=200)
    entity_id: str = Field(min_length=1, max_length=200)


def create_app(*, gateway=None):
    gateway = gateway or load_gateway()
    app = FastAPI(title="data-analysis Skill deterministic data access", version="1.0.0")

    @app.exception_handler(RequestValidationError)
    async def invalid_request(request, exc):
        # Do not echo supplied values, including non-JSON floats or secrets.
        return JSONResponse(status_code=422, content={"detail": [
            {key: error[key] for key in ("loc", "msg", "type")}
            for error in exc.errors()]})

    def call(operation, *args):
        try:
            return operation(*args)
        except (EntityBindingError, KnowledgeRequestError) as exc:
            raise HTTPException(400, {'code': exc.code, 'message': str(exc)}) from None
        except ValueError:
            raise HTTPException(400, "Unknown scenario/source or invalid catalog") from None
        except Exception:
            raise HTTPException(503, "Skill read-only gateway unavailable") from None

    @app.get("/api/scenarios")
    def scenarios():
        return call(gateway.scenarios)

    @app.get("/api/data/catalog")
    def catalog(scenario_id: Annotated[str, Query(min_length=1, max_length=200, pattern=r"^\S+$")],
                source_id: Annotated[list[str] | None, Query()] = None,
                question: Annotated[str | None, Query(min_length=1, max_length=4000)] = None):
        return call(gateway.catalog, scenario_id, source_id, question)

    @app.post("/api/data/execute")
    def execute(payload: SqlRequest):
        return call(gateway.execute_sql, payload.scenario_id, payload.sql, payload.params, payload.query_plan)

    @app.post('/api/data/metadata/{action}')
    def metadata(action: str, scenario_id: Annotated[str, Query(min_length=1, max_length=200, pattern=r'^\S+$')],
                 payload: dict):
        if action not in METADATA_ACTIONS:
            raise HTTPException(404, 'Unknown metadata action')
        return call(gateway.knowledge, action, scenario_id, payload)

    @app.post('/api/data/resolve-entity')
    def resolve_entity(payload: EntityRequest):
        return call(gateway.resolve_entity, payload.scenario_id, payload.model_dump(exclude={'scenario_id'}))

    @app.post('/api/data/decide')
    def decide(scenario_id: Annotated[str, Query(min_length=1, max_length=200, pattern=r'^\S+$')], payload: dict):
        return call(gateway.decide, scenario_id, payload)

    @app.post('/api/data/probe')
    def probe(scenario_id: Annotated[str, Query(min_length=1, max_length=200, pattern=r'^\S+$')], payload: dict):
        return call(gateway.probe, scenario_id, payload)

    return app


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=8001)
    args = parser.parse_args()
    if not 1 <= args.port <= 65535:
        parser.error("--port must be between 1 and 65535")
    try:
        app = create_app()
    except Exception:
        parser.error("Cannot load the Skill gateway; check root connections.json and dependencies")
    import uvicorn
    # Localhost only: no user authentication, no mutation of another service.
    uvicorn.run(app, host="127.0.0.1", port=args.port, access_log=False)


if __name__ == "__main__":
    main()
