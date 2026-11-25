FROM python:3.12-slim-bookworm

ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1

WORKDIR /app
# The quarterly snapshot zip is Deflate64-compressed — Python's stdlib
# zipfile doesn't support that compression method (confirmed directly,
# Phase 4), so extraction shells out to the system unzip binary instead.
RUN apt-get update && apt-get install -y --no-install-recommends unzip && rm -rf /var/lib/apt/lists/*
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY *.py ./
COPY *.json ./
COPY known_hosts ./known_hosts

RUN useradd -m -u 10003 leadsource && chown -R leadsource:leadsource /app
USER leadsource

CMD ["python", "worker.py"]
