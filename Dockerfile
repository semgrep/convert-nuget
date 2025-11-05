FROM mcr.microsoft.com/dotnet/sdk:8.0

RUN apt-get update && apt-get install -y --no-install-recommends curl \
    && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

COPY convert-nuget.js package.json package-lock.json /tool/
WORKDIR /tool
RUN npm install --production && chmod +x convert-nuget.js

# Default working directory (can be overridden with -w)
# The working directory should be mounted as a volume when running:
# docker run -v "$(pwd):/workspace" -w /workspace <image> [options]
WORKDIR /workspace
ENTRYPOINT ["node", "/tool/convert-nuget.js"]
