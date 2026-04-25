import logging
import os

import httpx
from dotenv import load_dotenv

from agent_server.redis_pub import publish_finding

load_dotenv()

logger = logging.getLogger(__name__)


async def run_search(
    query: str,
    slug: str,
    session_id: str,
    redis_url: str,
) -> list[dict]:
    api_key = os.environ.get("TAVILY_API_KEY", "")

    async with httpx.AsyncClient() as client:
        response = await client.post(
            "https://api.tavily.com/search",
            json={
                "api_key": api_key,
                "query": query,
                "max_results": 5,
            },
            timeout=30.0,
        )
        response.raise_for_status()
        data = response.json()

    results: list[dict] = data.get("results", [])

    for result in results:
        await publish_finding(redis_url, slug, {
            "type": "aria",
            "agentType": "search",
            "title": result.get("title", "Untitled"),
            "content": result.get("content", ""),
            "sourceUrl": result.get("url"),
            "sourceTitle": result.get("title"),
            "sessionId": session_id,
            "queryText": query,
            "slug": slug,
        })

    logger.info("[search] %d results published for %r", len(results), query)
    return results
