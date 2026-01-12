#!/bin/bash
set -e

cd "$(dirname "$0")"

echo "Pulling latest changes..."
git pull

echo "Building and starting containers..."
docker compose up -d --build

docker compose logs -f
