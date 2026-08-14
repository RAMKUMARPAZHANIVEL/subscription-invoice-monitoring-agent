# Monitoring & alerting (T210). Before this, the project had zero notification channels, alert
# policies, log-based metrics, or dashboards (confirmed live via `gcloud monitoring policies list`
# / `gcloud logging metrics list` / `gcloud monitoring dashboards list`, all "Listed 0 items" as of
# 2026-08-14) — production ran with no automated failure detection beyond manually reading logs.
#
# Scope is deliberately narrow: this service is invoked once daily by Cloud Scheduler, so the two
# failure modes that actually matter are (1) the scheduled HTTP call itself failing at the
# transport/response level, and (2) the request reaching the app but the app responding with a
# server error. Per-email extraction failures (a single vendor email failing AI extraction) are
# expected, business-as-usual outcomes already captured in ProcessingHistoryEntry / GET
# /processing-history per the constitution's Complete Auditability principle — those are not
# infrastructure alerts and are intentionally not paged on here.

resource "google_monitoring_notification_channel" "email" {
  project      = var.project_id
  display_name = "Invoice Monitor (SIMA) operator email"
  type         = "email"

  labels = {
    email_address = var.alert_notification_email
  }

  depends_on = [google_project_service.required]
}

# Fires if the Cloud Run service returns any 5xx response. Threshold is 0 (any occurrence) because
# traffic volume is intentionally tiny (one scheduler-triggered request per day plus occasional
# manual/API calls) — there is no "normal" 5xx rate to tolerate.
resource "google_monitoring_alert_policy" "cloud_run_5xx" {
  project      = var.project_id
  display_name = "SIMA: Cloud Run 5xx errors"
  combiner     = "OR"

  conditions {
    display_name = "request_count{response_code_class=5xx} > 0"

    condition_threshold {
      filter = join(" AND ", [
        "resource.type = \"cloud_run_revision\"",
        "resource.labels.service_name = \"${var.service_name}\"",
        "metric.type = \"run.googleapis.com/request_count\"",
        "metric.labels.response_code_class = \"5xx\"",
      ])
      comparison      = "COMPARISON_GT"
      threshold_value = 0
      duration        = "0s"

      aggregations {
        alignment_period   = "300s"
        per_series_aligner = "ALIGN_COUNT"
      }

      trigger {
        count = 1
      }
    }
  }

  notification_channels = [google_monitoring_notification_channel.email.id]

  documentation {
    content = join(" ", [
      "The Invoice Monitor Cloud Run service (${var.service_name}) returned a 5xx response.",
      "Since this service is only invoked once daily by Cloud Scheduler plus occasional manual",
      "calls, any 5xx likely means the scheduled ingestion run failed at the HTTP level (not a",
      "per-email extraction failure, which is recorded in ProcessingHistoryEntry and returns 200).",
      "Check Cloud Run logs (`gcloud run services logs read ${var.service_name}`) and",
      "GET /processing-history for detail.",
    ])
    mime_type = "text/markdown"
  }

  depends_on = [google_project_service.required]
}

# Cloud Scheduler's own built-in Cloud Monitoring metrics were not visible via the Monitoring API
# in this project at the time this was written (empty metricDescriptors response for any
# cloudscheduler.googleapis.com/* type), so this alert is built on a log-based metric derived from
# the job's own execution logs instead, which are confirmed present
# (resource.type="cloud_scheduler_job", jsonPayload."@type"=AttemptFinished).
resource "google_logging_metric" "scheduler_attempt_failures" {
  project     = var.project_id
  name        = "sima-scheduler-attempt-failures"
  description = "Counts Cloud Scheduler attempts against the SIMA daily ingestion job that did not receive a 2xx response."

  filter = join(" AND ", [
    "resource.type=\"cloud_scheduler_job\"",
    "resource.labels.job_id=\"${google_cloud_scheduler_job.ingest_invoices.name}\"",
    "jsonPayload.\"@type\"=\"type.googleapis.com/google.cloud.scheduler.logging.AttemptFinished\"",
    "httpRequest.status>=400",
  ])

  metric_descriptor {
    metric_kind = "DELTA"
    value_type  = "INT64"
    unit        = "1"
  }
}

resource "google_monitoring_alert_policy" "scheduler_failures" {
  project      = var.project_id
  display_name = "SIMA: Cloud Scheduler ingestion attempt failures"
  combiner     = "OR"

  conditions {
    display_name = "scheduler attempt response >= 400"

    condition_threshold {
      filter = join(" AND ", [
        "resource.type = \"cloud_scheduler_job\"",
        "metric.type = \"logging.googleapis.com/user/${google_logging_metric.scheduler_attempt_failures.name}\"",
      ])
      comparison      = "COMPARISON_GT"
      threshold_value = 0
      duration        = "0s"

      aggregations {
        alignment_period   = "300s"
        per_series_aligner = "ALIGN_COUNT"
      }

      trigger {
        count = 1
      }
    }
  }

  notification_channels = [google_monitoring_notification_channel.email.id]

  documentation {
    content = join(" ", [
      "A Cloud Scheduler attempt to trigger POST /tasks/ingest-invoices against the SIMA Cloud",
      "Run service did not receive a 2xx response. Cloud Scheduler retries up to",
      "var.scheduler_retry_count times with backoff before giving up for that day — if this alert",
      "fires, confirm whether the job eventually succeeded",
      "(`gcloud scheduler jobs describe ${var.service_name}-ingest-invoices`) or whether that",
      "day's ingestion did not run at all.",
    ])
    mime_type = "text/markdown"
  }

  depends_on = [google_project_service.required, google_cloud_scheduler_job.ingest_invoices]
}
