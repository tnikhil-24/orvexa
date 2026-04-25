import logging
import os
from urllib.parse import urlparse

from arq.connections import RedisSettings
from dotenv import load_dotenv

from agent_server.jobs import aria_job

load_dotenv()

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s [%(levelname)s] %(name)s: %(message)s',
)


def _parse_redis_url(url: str) -> RedisSettings:
    parsed = urlparse(url)
    return RedisSettings(
        host=parsed.hostname or "localhost",
        port=parsed.port or 6379,
    )


class WorkerSettings:
    functions = [aria_job]
    redis_settings = _parse_redis_url(
        os.environ.get("REDIS_URL", "redis://localhost:6379")
    )
