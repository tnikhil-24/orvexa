import asyncio
import logging
import os

from dotenv import load_dotenv

from agent_server.agents.factcheck import run_factcheck
from agent_server.agents.search import run_search
from agent_server.agents.summarizer import run_summarizer
from agent_server.redis_pub import publish_finding

load_dotenv()

logger = logging.getLogger(__name__)

_REDIS_URL = os.environ.get("REDIS_URL", "redis://localhost:6379")


async def _run_with_timeout(
    coro,
    timeout_secs: int,
    agent_type: str,
    slug: str,
    session_id: str,
    redis_url: str,
    query: str,
) -> None:
    try:
        await asyncio.wait_for(coro, timeout=timeout_secs)
    except asyncio.TimeoutError:
        if agent_type == "search":
            await publish_finding(redis_url, slug, {
                "type": "error",
                "agentType": agent_type,
                "title": "Search timed out",
                "content": f"No results within {timeout_secs}s.",
                "sessionId": session_id,
                "queryText": query,
                "slug": slug,
            })
        else:
            logger.warning(
                "[%s] timed out after %ds — stream_end published by agent",
                agent_type, timeout_secs,
            )
    except Exception as e:
        if agent_type == "search":
            await publish_finding(redis_url, slug, {
                "type": "error",
                "agentType": agent_type,
                "title": "Search failed",
                "content": str(e)[:200],
                "sessionId": session_id,
                "queryText": query,
                "slug": slug,
            })
        else:
            logger.error(
                "[%s] failed: %s — stream_end published by agent",
                agent_type, str(e)[:200],
            )


async def aria_job(ctx, slug: str, query: str, session_id: str) -> None:
    logger.info(
        "[aria_job] received — slug=%s  query=%r  session_id=%s",
        slug, query, session_id,
    )

    # ── Phase 1: search (sequential — provides data for Phase 2) ─
    results: list[dict] = []
    try:
        results = await asyncio.wait_for(
            run_search(query, slug, session_id, _REDIS_URL),
            timeout=30,
        )
        logger.info("[aria_job] search complete — %d results", len(results))
    except asyncio.TimeoutError:
        logger.warning("[aria_job] search timed out")
        await publish_finding(_REDIS_URL, slug, {
            "type": "error",
            "agentType": "search",
            "title": "Search timed out",
            "content": "Tavily search did not respond within 30s.",
            "sessionId": session_id,
            "queryText": query,
            "slug": slug,
        })
    except Exception as e:
        logger.error("[aria_job] search failed: %s", e)
        await publish_finding(_REDIS_URL, slug, {
            "type": "error",
            "agentType": "search",
            "title": "Search failed",
            "content": str(e)[:200],
            "sessionId": session_id,
            "queryText": query,
            "slug": slug,
        })

    # ── Phase 2: summary + factcheck in parallel ──────────────────
    # Runs even if search failed — empty results produces error cards
    await asyncio.gather(
        _run_with_timeout(
            run_summarizer(query, results, slug, session_id, _REDIS_URL),
            30, "summary", slug, session_id, _REDIS_URL, query,
        ),
        _run_with_timeout(
            run_factcheck(query, results, slug, session_id, _REDIS_URL),
            30, "factcheck", slug, session_id, _REDIS_URL, query,
        ),
        return_exceptions=True,
    )

    # Always publish done — even if one or more agents failed
    await publish_finding(_REDIS_URL, slug, {
        "type": "done",
        "slug": slug,
        "sessionId": session_id,
    })
    logger.info("[aria_job] done — slug=%s", slug)


aria_job.max_tries = 1  # type: ignore  — prevents duplicate cards on arq retry
