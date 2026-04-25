import logging
import os
from contextlib import asynccontextmanager
from urllib.parse import urlparse

from arq import create_pool
from arq.connections import RedisSettings
from dotenv import load_dotenv
from fastapi import FastAPI, Request
from pydantic import BaseModel

load_dotenv()

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


def _parse_redis_url(url: str) -> RedisSettings:
    parsed = urlparse(url)
    return RedisSettings(
        host=parsed.hostname or "localhost",
        port=parsed.port or 6379,
    )


@asynccontextmanager
async def lifespan(app: FastAPI):
    redis_settings = _parse_redis_url(
        os.environ.get("REDIS_URL", "redis://localhost:6379")
    )
    app.state.arq_pool = await create_pool(redis_settings)
    logger.info("[startup] arq Redis pool created")
    yield
    await app.state.arq_pool.close()
    logger.info("[shutdown] arq Redis pool closed")


app = FastAPI(lifespan=lifespan)


class TriggerBody(BaseModel):
    slug: str
    query: str
    sessionId: str


@app.post("/api/aria/trigger")
async def trigger(body: TriggerBody, request: Request):
    await request.app.state.arq_pool.enqueue_job(
        "aria_job", body.slug, body.query, body.sessionId
    )
    logger.info(
        "[trigger] job enqueued — slug=%s  query=%r", body.slug, body.query
    )
    return {"status": "queued"}
