-- CreateTable
CREATE TABLE "client_invitations" (
    "id" VARCHAR(26) NOT NULL,
    "orgId" VARCHAR(26) NOT NULL,
    "clientId" VARCHAR(26) NOT NULL,
    "tokenHash" VARCHAR(64) NOT NULL,
    "email" VARCHAR(320) NOT NULL,
    "firstName" VARCHAR(100),
    "lastName" VARCHAR(100),
    "expiresAt" TIMESTAMPTZ(6) NOT NULL,
    "acceptedAt" TIMESTAMPTZ(6),
    "acceptedUserId" VARCHAR(26),
    "revokedAt" TIMESTAMPTZ(6),
    "revokedById" VARCHAR(26),
    "createdById" VARCHAR(26) NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "client_invitations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "client_invitations_tokenHash_key" ON "client_invitations"("tokenHash");

-- CreateIndex
CREATE INDEX "client_invitations_orgId_clientId_createdAt_idx" ON "client_invitations"("orgId", "clientId", "createdAt");

-- CreateIndex
CREATE INDEX "client_invitations_orgId_expiresAt_idx" ON "client_invitations"("orgId", "expiresAt");

-- AddForeignKey
ALTER TABLE "client_invitations" ADD CONSTRAINT "client_invitations_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "client_invitations" ADD CONSTRAINT "client_invitations_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "clients"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "client_invitations" ADD CONSTRAINT "client_invitations_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
