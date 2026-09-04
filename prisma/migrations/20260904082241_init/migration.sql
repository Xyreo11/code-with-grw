-- CreateEnum
CREATE TYPE "Priority" AS ENUM ('HIGH', 'NORMAL', 'LOW');

-- CreateEnum
CREATE TYPE "Intent" AS ENUM ('CONSIDERING_BUY', 'HOLDING', 'THEMATIC', 'HEDGE', 'NONE');

-- CreateEnum
CREATE TYPE "Severity" AS ENUM ('CRITICAL', 'IMPORTANT', 'WATCH', 'INFO', 'NOISE');

-- CreateEnum
CREATE TYPE "EventStatus" AS ENUM ('UNSEEN', 'SEEN', 'DISMISSED', 'SNOOZED', 'ACTED');

-- CreateEnum
CREATE TYPE "BreakerState" AS ENUM ('CLOSED', 'OPEN', 'HALF_OPEN');

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "settings" JSONB NOT NULL DEFAULT '{}',
    "lastActiveAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sessions" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "watchlists" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL DEFAULT 'My Watchlist',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "watchlists_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "watchlist_items" (
    "id" TEXT NOT NULL,
    "watchlistId" TEXT NOT NULL,
    "instrumentId" TEXT NOT NULL,
    "intent" "Intent" NOT NULL DEFAULT 'NONE',
    "priority" "Priority" NOT NULL DEFAULT 'NORMAL',
    "targetHigh" DECIMAL(18,6),
    "targetLow" DECIMAL(18,6),
    "addedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "watchlist_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "instruments" (
    "id" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "sector" TEXT,
    "sectorEtfId" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "isEtf" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "instruments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "daily_bars" (
    "instrumentId" TEXT NOT NULL,
    "barDate" DATE NOT NULL,
    "open" DECIMAL(18,6) NOT NULL,
    "high" DECIMAL(18,6) NOT NULL,
    "low" DECIMAL(18,6) NOT NULL,
    "close" DECIMAL(18,6) NOT NULL,
    "closeAdj" DECIMAL(18,6) NOT NULL,
    "volume" BIGINT NOT NULL,
    "source" TEXT NOT NULL,
    "asOf" TIMESTAMP(3) NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 1.0,
    "confirmed" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "daily_bars_pkey" PRIMARY KEY ("instrumentId","barDate")
);

-- CreateTable
CREATE TABLE "bar_conflicts" (
    "id" TEXT NOT NULL,
    "instrumentId" TEXT NOT NULL,
    "barDate" DATE NOT NULL,
    "field" TEXT NOT NULL,
    "sourceA" TEXT NOT NULL,
    "valueA" DECIMAL(18,6) NOT NULL,
    "sourceB" TEXT NOT NULL,
    "valueB" DECIMAL(18,6) NOT NULL,
    "deltaPct" DOUBLE PRECISION NOT NULL,
    "resolvedTo" TEXT NOT NULL,
    "detectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bar_conflicts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "earnings_events" (
    "id" TEXT NOT NULL,
    "instrumentId" TEXT NOT NULL,
    "reportDate" DATE NOT NULL,
    "session" TEXT,
    "epsEstimate" DOUBLE PRECISION,
    "epsActual" DOUBLE PRECISION,
    "source" TEXT NOT NULL,

    CONSTRAINT "earnings_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "features_daily" (
    "instrumentId" TEXT NOT NULL,
    "barDate" DATE NOT NULL,
    "vec" JSONB NOT NULL,
    "atr14" DOUBLE PRECISION,
    "rv10" DOUBLE PRECISION,
    "rv60" DOUBLE PRECISION,
    "betaSpy" DOUBLE PRECISION,
    "betaSector" DOUBLE PRECISION,
    "residSpy" DOUBLE PRECISION,
    "residSector" DOUBLE PRECISION,
    "engineV" TEXT NOT NULL,
    "computedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "features_daily_pkey" PRIMARY KEY ("instrumentId","barDate")
);

-- CreateTable
CREATE TABLE "events" (
    "id" TEXT NOT NULL,
    "instrumentId" TEXT NOT NULL,
    "marketTime" TIMESTAMP(3) NOT NULL,
    "detectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "type" TEXT NOT NULL,
    "direction" INTEGER NOT NULL DEFAULT 0,
    "magnitude" DOUBLE PRECISION NOT NULL,
    "features" JSONB NOT NULL,
    "contributions" JSONB NOT NULL,
    "score" DOUBLE PRECISION NOT NULL,
    "severity" "Severity" NOT NULL,
    "scorerV" TEXT NOT NULL,
    "sources" TEXT[],
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 1.0,
    "headline" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "themeId" TEXT,
    "supersedesId" TEXT,
    "scenarioId" TEXT,

    CONSTRAINT "events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "themes" (
    "id" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "scopeKey" TEXT NOT NULL,
    "windowStart" TIMESTAMP(3) NOT NULL,
    "windowEnd" TIMESTAMP(3) NOT NULL,
    "memberCount" INTEGER NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL,
    "cohesion" DOUBLE PRECISION NOT NULL,
    "timing" DOUBLE PRECISION NOT NULL,
    "size" DOUBLE PRECISION NOT NULL,
    "distinctness" DOUBLE PRECISION NOT NULL,
    "characteristics" TEXT[],
    "summary" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "scenarioId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "themes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "narratives" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "windowStart" TIMESTAMP(3) NOT NULL,
    "windowEnd" TIMESTAMP(3) NOT NULL,
    "ruleId" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "inputs" JSONB NOT NULL,
    "scenarioId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "narratives_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "scenarios" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "startDate" DATE NOT NULL,
    "endDate" DATE NOT NULL,
    "symbols" TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "scenarios_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_watch_state" (
    "userId" TEXT NOT NULL,
    "instrumentId" TEXT NOT NULL,
    "lastSeenAt" TIMESTAMP(3) NOT NULL,
    "lastSeenSnap" JSONB NOT NULL,
    "cursorVersion" BIGINT NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_watch_state_pkey" PRIMARY KEY ("userId","instrumentId")
);

-- CreateTable
CREATE TABLE "user_event_state" (
    "userId" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "status" "EventStatus" NOT NULL DEFAULT 'UNSEEN',
    "snoozedUntil" TIMESTAMP(3),
    "actedKind" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_event_state_pkey" PRIMARY KEY ("userId","eventId")
);

-- CreateTable
CREATE TABLE "data_sources" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "trustRank" INTEGER NOT NULL,
    "rateLimit" JSONB NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "data_sources_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "data_freshness" (
    "sourceId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "lastSuccess" TIMESTAMP(3),
    "lastAttempt" TIMESTAMP(3),
    "lastError" TEXT,
    "breakerState" "BreakerState" NOT NULL DEFAULT 'CLOSED',
    "consecutiveFailures" INTEGER NOT NULL DEFAULT 0,
    "lagSeconds" INTEGER,

    CONSTRAINT "data_freshness_pkey" PRIMARY KEY ("sourceId","kind")
);

-- CreateTable
CREATE TABLE "ingest_runs" (
    "id" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "rowsIn" INTEGER NOT NULL DEFAULT 0,
    "rowsRejected" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'running',
    "note" TEXT,

    CONSTRAINT "ingest_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dead_letters" (
    "id" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "symbol" TEXT,
    "payload" JSONB NOT NULL,
    "reason" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "dead_letters_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE INDEX "sessions_userId_idx" ON "sessions"("userId");

-- CreateIndex
CREATE INDEX "sessions_expiresAt_idx" ON "sessions"("expiresAt");

-- CreateIndex
CREATE INDEX "watchlists_userId_idx" ON "watchlists"("userId");

-- CreateIndex
CREATE INDEX "watchlist_items_instrumentId_idx" ON "watchlist_items"("instrumentId");

-- CreateIndex
CREATE UNIQUE INDEX "watchlist_items_watchlistId_instrumentId_key" ON "watchlist_items"("watchlistId", "instrumentId");

-- CreateIndex
CREATE UNIQUE INDEX "instruments_symbol_key" ON "instruments"("symbol");

-- CreateIndex
CREATE INDEX "instruments_sector_idx" ON "instruments"("sector");

-- CreateIndex
CREATE INDEX "daily_bars_barDate_idx" ON "daily_bars"("barDate");

-- CreateIndex
CREATE INDEX "bar_conflicts_instrumentId_barDate_idx" ON "bar_conflicts"("instrumentId", "barDate");

-- CreateIndex
CREATE INDEX "earnings_events_reportDate_idx" ON "earnings_events"("reportDate");

-- CreateIndex
CREATE UNIQUE INDEX "earnings_events_instrumentId_reportDate_key" ON "earnings_events"("instrumentId", "reportDate");

-- CreateIndex
CREATE INDEX "events_instrumentId_marketTime_idx" ON "events"("instrumentId", "marketTime" DESC);

-- CreateIndex
CREATE INDEX "events_scenarioId_marketTime_idx" ON "events"("scenarioId", "marketTime");

-- CreateIndex
CREATE INDEX "events_severity_marketTime_idx" ON "events"("severity", "marketTime" DESC);

-- CreateIndex
CREATE INDEX "events_themeId_idx" ON "events"("themeId");

-- CreateIndex
CREATE UNIQUE INDEX "events_fingerprint_key" ON "events"("fingerprint");

-- CreateIndex
CREATE INDEX "themes_scopeKey_windowEnd_idx" ON "themes"("scopeKey", "windowEnd");

-- CreateIndex
CREATE INDEX "themes_scenarioId_idx" ON "themes"("scenarioId");

-- CreateIndex
CREATE INDEX "narratives_userId_windowEnd_idx" ON "narratives"("userId", "windowEnd");

-- CreateIndex
CREATE INDEX "narratives_scenarioId_idx" ON "narratives"("scenarioId");

-- CreateIndex
CREATE UNIQUE INDEX "scenarios_slug_key" ON "scenarios"("slug");

-- CreateIndex
CREATE INDEX "user_event_state_userId_status_idx" ON "user_event_state"("userId", "status");

-- CreateIndex
CREATE INDEX "ingest_runs_sourceId_startedAt_idx" ON "ingest_runs"("sourceId", "startedAt" DESC);

-- CreateIndex
CREATE INDEX "dead_letters_sourceId_createdAt_idx" ON "dead_letters"("sourceId", "createdAt" DESC);

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "watchlists" ADD CONSTRAINT "watchlists_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "watchlist_items" ADD CONSTRAINT "watchlist_items_watchlistId_fkey" FOREIGN KEY ("watchlistId") REFERENCES "watchlists"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "watchlist_items" ADD CONSTRAINT "watchlist_items_instrumentId_fkey" FOREIGN KEY ("instrumentId") REFERENCES "instruments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "instruments" ADD CONSTRAINT "instruments_sectorEtfId_fkey" FOREIGN KEY ("sectorEtfId") REFERENCES "instruments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "daily_bars" ADD CONSTRAINT "daily_bars_instrumentId_fkey" FOREIGN KEY ("instrumentId") REFERENCES "instruments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bar_conflicts" ADD CONSTRAINT "bar_conflicts_instrumentId_fkey" FOREIGN KEY ("instrumentId") REFERENCES "instruments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "earnings_events" ADD CONSTRAINT "earnings_events_instrumentId_fkey" FOREIGN KEY ("instrumentId") REFERENCES "instruments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "features_daily" ADD CONSTRAINT "features_daily_instrumentId_fkey" FOREIGN KEY ("instrumentId") REFERENCES "instruments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "events" ADD CONSTRAINT "events_instrumentId_fkey" FOREIGN KEY ("instrumentId") REFERENCES "instruments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "events" ADD CONSTRAINT "events_themeId_fkey" FOREIGN KEY ("themeId") REFERENCES "themes"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "events" ADD CONSTRAINT "events_supersedesId_fkey" FOREIGN KEY ("supersedesId") REFERENCES "events"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "events" ADD CONSTRAINT "events_scenarioId_fkey" FOREIGN KEY ("scenarioId") REFERENCES "scenarios"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "themes" ADD CONSTRAINT "themes_scenarioId_fkey" FOREIGN KEY ("scenarioId") REFERENCES "scenarios"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "narratives" ADD CONSTRAINT "narratives_scenarioId_fkey" FOREIGN KEY ("scenarioId") REFERENCES "scenarios"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_watch_state" ADD CONSTRAINT "user_watch_state_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_watch_state" ADD CONSTRAINT "user_watch_state_instrumentId_fkey" FOREIGN KEY ("instrumentId") REFERENCES "instruments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_event_state" ADD CONSTRAINT "user_event_state_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_event_state" ADD CONSTRAINT "user_event_state_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "events"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "data_freshness" ADD CONSTRAINT "data_freshness_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "data_sources"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ingest_runs" ADD CONSTRAINT "ingest_runs_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "data_sources"("id") ON DELETE CASCADE ON UPDATE CASCADE;
