import json
import logging

import redis.asyncio as aioredis

logger = logging.getLogger(__name__)


async def publish_finding(redis_url: str, slug: str, payload: dict) -> None:
    r = aioredis.from_url(redis_url)
    try:
        await r.publish(f"room:{slug}:findings", json.dumps(payload))
        logger.info(
            "[publish_finding] slug=%s  type=%s  agentType=%s",
            slug, payload.get("type"), payload.get("agentType"),
        )
    finally:
        await r.aclose()
