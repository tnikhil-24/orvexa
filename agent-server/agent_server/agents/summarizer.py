import logging

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

    async with anthropic.AsyncAnthropic() as client:
        response = await client.messages.create(
            model="claude-sonnet-4-6",
            max_tokens=300,
            messages=[{"role": "user", "content": prompt}],
        )

    if not response.content or not response.content[0].text:
        await publish_finding(redis_url, slug, {
            "type": "error",
            "agentType": "summary",
            "title": "Empty response from Claude",
            "content": "Claude returned an empty response. Please try again.",
            "sessionId": session_id,
            "queryText": query,
            "slug": slug,
        })
        return
    summary_text = response.content[0].text

    await publish_finding(redis_url, slug, {
        "type": "aria",
        "agentType": "summary",
        "title": f'Summary: "{query}"',
        "content": summary_text,
        "sessionId": session_id,
        "queryText": query,
        "slug": slug,
    })
    logger.info("[summarizer] published summary for %r", query)
