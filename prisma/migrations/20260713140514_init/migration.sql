-- CreateEnum
CREATE TYPE "SubscriptionType" AS ENUM ('FIXED_MONTHLY', 'USAGE_BASED', 'PER_SEAT');

-- CreateEnum
CREATE TYPE "ExtractionConfidence" AS ENUM ('HIGH', 'LOW');

-- CreateEnum
CREATE TYPE "ProcessingOutcome" AS ENUM ('PROCESSED', 'FAILED', 'SKIPPED_NOT_INVOICE', 'RETRYING');

-- CreateTable
CREATE TABLE "Vendor" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "senderPatterns" TEXT[],
    "subjectPatterns" TEXT[],
    "defaultSubscriptionType" "SubscriptionType",
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Vendor_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SourceEmail" (
    "id" TEXT NOT NULL,
    "gmailMessageId" TEXT NOT NULL,
    "vendorId" TEXT,
    "sender" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL,
    "bodyTextExcerpt" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SourceEmail_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Attachment" (
    "id" TEXT NOT NULL,
    "sourceEmailId" TEXT NOT NULL,
    "invoiceId" TEXT,
    "filename" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "storageRef" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Attachment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Invoice" (
    "id" TEXT NOT NULL,
    "sourceEmailId" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "amount" DECIMAL(65,30) NOT NULL,
    "currency" TEXT NOT NULL,
    "invoiceDate" TIMESTAMP(3) NOT NULL,
    "billingPeriodStart" TIMESTAMP(3),
    "billingPeriodEnd" TIMESTAMP(3),
    "subscriptionType" "SubscriptionType",
    "lineItems" JSONB,
    "extractionConfidence" "ExtractionConfidence" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Invoice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProcessingHistoryEntry" (
    "id" TEXT NOT NULL,
    "sourceEmailId" TEXT NOT NULL,
    "invoiceId" TEXT,
    "outcome" "ProcessingOutcome" NOT NULL,
    "attemptNumber" INTEGER NOT NULL DEFAULT 1,
    "errorReason" TEXT,
    "evaluatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProcessingHistoryEntry_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Vendor_name_key" ON "Vendor"("name");

-- CreateIndex
CREATE UNIQUE INDEX "SourceEmail_gmailMessageId_key" ON "SourceEmail"("gmailMessageId");

-- CreateIndex
CREATE INDEX "SourceEmail_vendorId_idx" ON "SourceEmail"("vendorId");

-- CreateIndex
CREATE INDEX "Attachment_sourceEmailId_idx" ON "Attachment"("sourceEmailId");

-- CreateIndex
CREATE INDEX "Attachment_invoiceId_idx" ON "Attachment"("invoiceId");

-- CreateIndex
CREATE UNIQUE INDEX "Invoice_sourceEmailId_key" ON "Invoice"("sourceEmailId");

-- CreateIndex
CREATE INDEX "Invoice_vendorId_idx" ON "Invoice"("vendorId");

-- CreateIndex
CREATE INDEX "ProcessingHistoryEntry_sourceEmailId_idx" ON "ProcessingHistoryEntry"("sourceEmailId");

-- CreateIndex
CREATE INDEX "ProcessingHistoryEntry_invoiceId_idx" ON "ProcessingHistoryEntry"("invoiceId");

-- AddForeignKey
ALTER TABLE "SourceEmail" ADD CONSTRAINT "SourceEmail_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "Vendor"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Attachment" ADD CONSTRAINT "Attachment_sourceEmailId_fkey" FOREIGN KEY ("sourceEmailId") REFERENCES "SourceEmail"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Attachment" ADD CONSTRAINT "Attachment_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_sourceEmailId_fkey" FOREIGN KEY ("sourceEmailId") REFERENCES "SourceEmail"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "Vendor"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProcessingHistoryEntry" ADD CONSTRAINT "ProcessingHistoryEntry_sourceEmailId_fkey" FOREIGN KEY ("sourceEmailId") REFERENCES "SourceEmail"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProcessingHistoryEntry" ADD CONSTRAINT "ProcessingHistoryEntry_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE SET NULL ON UPDATE CASCADE;
