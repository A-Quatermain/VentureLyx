FROM python:3.12-slim-bookworm

ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY *.py ./
COPY *.json ./
COPY known_hosts ./known_hosts

RUN useradd -m -u 10003 leadsource && chown -R leadsource:leadsource /app
USER leadsource

CMD ["python", "worker.py"]
