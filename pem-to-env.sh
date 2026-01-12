#!/bin/bash
PEM=$(awk 'NF {sub(/\r/, ""); printf "%s\\n",$0;}' *.pem | head -1)
echo "GITHUB_APP_PRIVATE_KEY=\"$PEM\"" >> .env
