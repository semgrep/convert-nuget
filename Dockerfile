# Build on the official .NET SDK image (Debian-based)
# Using 8.0 LTS for stability and long-term support
FROM mcr.microsoft.com/dotnet/sdk:8.0

# Install Node.js (required for the script)
RUN apt-get update && apt-get install -y --no-install-recommends curl \
    && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

# Create a workspace and copy entrypoint script
WORKDIR /tool
COPY convert-nuget.js /tool/convert-nuget.js

RUN chmod +x /tool/convert-nuget.js

# Default entrypoint: process current working directory
# The working directory should be mounted as a volume when running:
# docker run -v "$(pwd):/workspace" -w /workspace <image> [options]
ENTRYPOINT ["node", "/tool/convert-nuget.js"]
