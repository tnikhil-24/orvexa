import logging
import uuid

import anthropic
from dotenv import load_dotenv

from agent_server.redis_pub import publish_finding

load_dotenv()

logger = logging.getLogger(__name__)


async def run_summarizer(
    query: str,
    search_results: list[dict],
    slug: str,
    session_id: str,
    redis_url: str,
) -> None:
    if not search_results:
        await publish_finding(redis_url, slug, {
            "type": "error",
            "agentType": "summary",
            "title": "Summary unavailable",
            "content": "No search results to summarize.",
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
        f"Summarize the following search results for the query '{query}' "
        f"in 2-3 sentences. Focus on the key findings.\n\n{snippets}"
    )

    card_id = str(uuid.uuid4())
    await publish_finding(redis_url, slug, {
        "type": "stream_start",
        "cardId": card_id,
        "agentType": "summary",
        "title": f'Summary: "{query}"',
        "sessionId": session_id,
        "queryText": query,
        "slug": slug,
    })

    stream_end_published = False
    try:
        try:
            async with anthropic.AsyncAnthropic() as client:
                async with client.messages.stream(
                    model="claude-sonnet-4-6",
                    max_tokens=300,
                    messages=[{"role": "user", "content": prompt}],
                ) as stream:
                    async for text in stream.text_stream:
                        await publish_finding(redis_url, slug, {
                            "type": "stream_chunk",
                            "cardId": card_id,
                            "chunk": text,
                            "slug": slug,
                        })
        finally:
            stream_end_published = True
            await publish_finding(redis_url, slug, {
                "type": "stream_end",
                "cardId": card_id,
                "slug": slug,
            })
    except Exception:
        if not stream_end_published:
            await publish_finding(redis_url, slug, {
                "type": "stream_end",
                "cardId": card_id,
                "slug": slug,
            })
        raise
    logger.info("[summarizer] streamed summary for %r", query)
