import logging
import re

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

    async with anthropic.AsyncAnthropic() as client:
        response = await client.messages.create(
            model="claude-sonnet-4-6",
            max_tokens=400,
            messages=[{"role": "user", "content": prompt}],
        )

    if not response.content or not response.content[0].text:
        await publish_finding(redis_url, slug, {
            "type": "error",
            "agentType": "factcheck",
            "title": "Empty response from Claude",
            "content": "Claude returned an empty response. Please try again.",
            "sessionId": session_id,
            "queryText": query,
            "slug": slug,
        })
        return
    response_text = response.content[0].text

    match = re.search(r'CONFIDENCE:\s*([0-9]*\.?[0-9]+)', response_text)
    confidence = float(match.group(1)) if match else 0.5
    confidence = max(0.0, min(1.0, confidence))

    content_text = re.sub(r'CONFIDENCE:\s*[0-9.]+', '', response_text).strip()

    conflict_terms = ["conflict", "conflicts", "conflicting", "contradicts", "contradict"]
    has_conflict = any(term in response_text.lower() for term in conflict_terms)

    await publish_finding(redis_url, slug, {
        "type": "aria",
        "agentType": "factcheck",
        "title": f'Fact-check: "{query}"',
        "content": content_text,
        "confidenceScore": confidence,
        "hasConflict": has_conflict,
        "sessionId": session_id,
        "queryText": query,
        "slug": slug,
    })
    logger.info(
        "[factcheck] published for %r — confidence=%.2f  conflict=%s",
        query, confidence, has_conflict,
    )
