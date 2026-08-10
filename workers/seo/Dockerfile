FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY *.py ./

# Never run as root. The crawler parses hostile HTML from the open internet.
RUN useradd -m -u 10001 crawler && chown -R crawler:crawler /app
USER crawler

CMD ["python", "worker.py"]
