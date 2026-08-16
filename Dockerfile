FROM python:3.11-slim

WORKDIR /app

# Install curl, ffmpeg, poppler-utils (PDF tools) and build dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    curl \
    ffmpeg \
    poppler-utils \
    && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/*

# Install uv (faster pip replacement)
RUN pip install uv

# Copy the dependencies file
COPY pyproject.toml ./

# Create empty package structure to allow pip install -e . to succeed for dependency caching
RUN mkdir -p research_agent feeder feeder_agent && \
    touch research_agent/__init__.py feeder/__init__.py feeder_agent/__init__.py

# Install the application and its dependencies (including langgraph-cli)
RUN uv pip install --system -e .

# Copy application source
COPY . .

# Create output directories (gitignored so not in source — must exist at runtime)
RUN mkdir -p output/candidate_images

# Expose the exact port that the Next.js UI expects (2024)
EXPOSE 2024

# Set required environment variables for LangGraph and unrestricted runtime pip/uv installs
ENV LANGGRAPH_HOST=0.0.0.0
ENV LANGGRAPH_PORT=2024
ENV PIP_BREAK_SYSTEM_PACKAGES=1
ENV UV_SYSTEM_PYTHON=1

# For self-hosting LangGraph, we use the integrated open-source CLI server
# because your Next.js UI strictly expects the LangGraph REST API endpoints.
# Also run the feeder HTTP server on port 8080 so the frontend can trigger it.
# We also automatically run setup_db.py to create and seed the database on startup.
CMD sh -c "python setup_db.py && python feeder_server.py & langgraph dev --host 0.0.0.0 --port 2024 --n-jobs-per-worker 10 --no-reload --allow-blocking"
