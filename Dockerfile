# Imagen base oficial de Playwright (incluye Node + chromium portable)
FROM mcr.microsoft.com/playwright:v1.63.0-jammy

# Instala JMeter (requiere Java, ya incluido en OpenJDK de la imagen)
ENV JMETER_VERSION=5.6.3
ENV JMETER_HOME=/opt/apache-jmeter-${JMETER_VERSION}

RUN apt-get update \
    && apt-get install -y --no-install-recommends wget unzip openjdk-17-jre \
    && rm -rf /var/lib/apt/lists/* \
    && wget -q "https://dlcdn.apache.org//jmeter/binaries/apache-jmeter-${JMETER_VERSION}.zip" -O /tmp/jmeter.zip \
    && unzip -q /tmp/jmeter.zip -d /opt \
    && rm /tmp/jmeter.zip \
    && ln -s ${JMETER_HOME}/bin/jmeter /usr/local/bin/jmeter

WORKDIR /app

# Copia package.json primero para cachear la capa de dependencias
COPY package.json package-lock.json ./
RUN npm ci

# Copia el resto del proyecto
COPY . .

# Playwright usa chromium bundled y headless en Docker
ENV PW_CHANNEL=chromium
ENV PW_HEADLESS=true

# Instala el navegador chromium de Playwright (imagen ya incluye dependencias del SO)
RUN npx playwright install chromium

CMD ["npm", "run", "test:stress"]