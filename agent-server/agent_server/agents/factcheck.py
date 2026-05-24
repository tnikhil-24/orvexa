import logging
import re
import uuid

import anthropic
from dotenv import load_dotenv

from agent_server.redis_pub import publish_finding

load_dotenv()

logger = logging.getLogger(__name__)


async def run_factcheck(
    query: str,
    search_results: list[dict],
    slug: str,
    session_id: str,
    redis_url: str,
) -> None:
    if not search_results:
        await publish_finding(redis_url, slug, {
            "type": "error",
            "agentType": "factcheck",
            "title": "Fact-check unavailable",
            "content": "No search results to fact-check.",
            "sessionId": session_id,
            "queryText": query,
            "slug": slug,
        })
        return

    snippets = "\n\n".join(
        f"Source {i + 1}: {r.get('content', '')[:500]}"
        for i, r in enumerate(search_results[:3])
    )
    prompt = (
        f"Review these search results for '{query}'. "
        f"Identify any conflicting claims between sources. "
        f"Rate your confidence that the main claim is accurate from 0.0 to 1.0. "
        f"End your response with exactly: CONFIDENCE: 0.X\n\n{snippets}"
    )

    card_id = str(uuid.uuid4())
    await publish_finding(redis_url, slug, {
        "type": "stream_start",
        "cardId": card_id,
        "agentType": "factcheck",
        "title": f'Fact Check: "{query}"',
        "sessionId": session_id,
        "queryText": query,
        "slug": slug,
    })

    accumulated = ""
    stream_end_published = False
    try:
        try:
            async with anthropic.AsyncAnthropic() as client:
                async with client.messages.stream(
                    model="claude-sonnet-4-6",
                    max_tokens=400,
                    messages=[{"role": "user", "content": prompt}],
                ) as stream:
                    async for text in stream.text_stream:
                        accumulated += text
                        await publish_finding(redis_url, slug, {
                            "type": "stream_chunk",
                            "cardId": card_id,
                            "chunk": text,
                            "slug": slug,
                        })
        finally:
            match = re.search(r'CONFIDENCE:\s*([0-9]*\.?[0-9]+)', accumulated)
            confidence = float(match.group(1)) if match else 0.5
            confidence = max(0.0, min(1.0, confidence))

            content_text = re.sub(
                r'CONFIDENCE:\s*[0-9]*\.?[0-9]+', '', accumulated
            ).strip()

            conflict_terms = [
                "conflict", "conflicts", "conflicting",
                "contradicts", "contradict",
            ]
            has_conflict = any(term in accumulated.lower() for term in conflict_terms)

            stream_end_published = True
            await publish_finding(redis_url, slug, {
                "type": "stream_end",
                "cardId": card_id,
                "slug": slug,
                "confidenceScore": confidence,
                "hasConflict": has_conflict,
                "finalContent": content_text,
            })
    except Exception:
        if not stream_end_published:
            await publish_finding(redis_url, slug, {
                "type": "stream_end",
                "cardId": card_id,
                "slug": slug,
            })
        raise
    logger.info(
        "[factcheck] streamed for %r — confidence=%.2f  conflict=%s",
        query, confidence, has_conflict,
    )
