/*
 * Copyright (c) 2026 Mana Nekoha
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { EXTENSION_DISPLAY_NAME, PROTOCOL_VERSION, REQUIRED_TRANSPORT } from './constants.js';
import { MODEL_POLICY_SNAPSHOT } from './model-policy.js';
import { localizeGoogleUpstreamError } from './google-errors.js';

export const MESSAGES = Object.freeze({
    "vertex_paygo.logs.preview.copy_record": "Copy this log entry",
    "vertex_paygo.logs.preview.record_copied": "Log entry copied.",
    "vertex_paygo.costs.title": "Conversation cost estimate",
    "vertex_paygo.costs.refresh": "Refresh usage",
    "vertex_paygo.costs.close": "Close",
    "vertex_paygo.tier.guide.summary": "Service tier guide",
    "vertex_paygo.tier.guide.order": "Standard: default tier. Flex: lower-cost tier.",
    "vertex_paygo.tier.guide.standard": "- Standard: Standard priority and rates, used by default.",
    "vertex_paygo.tier.guide.flex": "- Flex: Lower priority and discounted rates. Busy periods may cause longer waits or failures.",
    "vertex_paygo.tier.guide.vertex_limits": "- Limits: Tiers depend on model support. Vertex Flex requires global. Failed requests are not retried as Standard.",
    "vertex_paygo.tier.guide.studio_limits": "- Limits: Tiers depend on model support. AI Studio Flex requires a paid account. Failed requests are not retried as Standard.",
    "vertex_paygo.server_error.priority_removed": "Priority has been removed. Refresh the frontend and use Standard or Flex.",
    "vertex_paygo.tier.name.standard": "Standard",
    "vertex_paygo.tier.name.flex": "Flex",
    "vertex_paygo.tier.name.priority": "Priority",
    "vertex_paygo.tier.description.standard": "Standard priority and rates for regular requests.",
    "vertex_paygo.tier.description.flex": "Lower priority and discounted rates. Busy periods may cause longer waits or failures.",
    "vertex_paygo.tier.note.vertex_global": "Available tiers depend on model support. Vertex Flex requires global.",
    "vertex_paygo.tier.note.ai_studio_paid": "Available tiers depend on model support. AI Studio Flex requires a paid account; no Vertex region setting is needed.",
    "vertex_paygo.tier.note.unverified": "Unverified options depend on Google’s actual support.",
    "vertex_paygo.tier.note.flex_failure": "Failed Flex requests are not retried as Standard.",
    "vertex_paygo.tier.unverified": "Unverified",
    "vertex_paygo.tier.choose_supported": "Choose a supported tier",
    "vertex_paygo.tier.restore_standard": "Use Standard",
    "vertex_paygo.guidance.standard_only": "Current support information lists Standard only.",
    "vertex_paygo.guidance.vertex_supported": "Only supported tiers are listed. Flex costs less but may take longer; Vertex Flex requires global.",
    "vertex_paygo.guidance.ai_studio_supported": "Only supported tiers are listed. AI Studio Flex requires a paid account; no Vertex region setting is needed.",
    "vertex_paygo.guidance.vertex_unverified": "Extended tiers are unverified for this model. Confirm Google support; Vertex Flex requires global.",
    "vertex_paygo.guidance.ai_studio_unverified": "AI Studio Flex support is unverified for this model. Confirm provider support.",
    "vertex_paygo.server_error.paygo_only_removed": "Force PayGo-only has been removed. Refresh the frontend to clear the obsolete option.",
    "vertex_paygo.guidance": "Only supported tiers are listed. Flex costs less but may take longer; Vertex Flex requires global.",
    "vertex_paygo.status.native_standard": "Standard keeps the standard tier and records returned token usage through the server.",
    "vertex_paygo.tauri.persistence": "Settings are saved to native Additional Parameters or the selected Model Target. Return to Standard before disabling the extension to clear managed tier headers.",
    "vertex_paygo.tauritavern.vertex_tiers": "Flex uses discounted rates. Return to Standard by removing managed tier headers, including legacy force-shared headers.",
    "vertex_paygo.version.frontend": "Frontend",
    "vertex_paygo.version.backend": "Backend",
    "vertex_paygo.server.state.ready": "Connected",
    "vertex_paygo.server.state.checking": "Checking…",
    "vertex_paygo.server.state.unavailable": "Unavailable",
    "vertex_paygo.logs.preview.preview": "Preview",
    "vertex_paygo.logs.preview.original": "Original",
    "vertex_paygo.logs.preview.view_mode": "Log view",
    "vertex_paygo.logs.preview.search": "Search events or details",
    "vertex_paygo.logs.preview.level": "Log level",
    "vertex_paygo.logs.preview.level_all": "All levels",
    "vertex_paygo.logs.preview.level_error": "Error",
    "vertex_paygo.logs.preview.level_warn": "Warning",
    "vertex_paygo.logs.preview.level_info": "Info",
    "vertex_paygo.logs.preview.level_unknown": "Raw",
    "vertex_paygo.logs.preview.source_server": "Server",
    "vertex_paygo.logs.preview.source_client": "Client",
    "vertex_paygo.logs.preview.raw_entry": "Raw log entry",
    "vertex_paygo.logs.preview.timestamp": "Time",
    "vertex_paygo.logs.preview.event_code": "Event code",
    "vertex_paygo.logs.preview.raw_record": "Original JSON",
    "vertex_paygo.logs.preview.unparsed": "Unable to parse this log event. Original text retained.",
    "vertex_paygo.logs.preview.oversized": "Preview parsing limit exceeded. Original text retained.",
    "vertex_paygo.logs.preview.more_fields": "See original JSON for all fields.",
    "vertex_paygo.logs.preview.count": "{shown} / {matched} matches · {total} entries, newest first",
    "vertex_paygo.logs.preview.no_matches": "No matching log entries.",
    "vertex_paygo.logs.preview.limit": "Preview: latest {count} / {total} entries. Original view and download include all entries.",
    "vertex_paygo.logs.preview.raw_hint": "Complete original log. Search and level filters apply to preview.",
    "vertex_paygo.logs.preview.page": "{page} / {pages}",
    "vertex_paygo.logs.preview.pages": "Log pages",
    "vertex_paygo.logs.preview.previous": "Previous page",
    "vertex_paygo.logs.preview.next": "Next page",
    "vertex_paygo.logs.preview.copy_raw": "Copy original log",
    "vertex_paygo.logs.preview.download_raw": "Download original log",
    "vertex_paygo.logs.preview.copied": "Original log copied.",
    "vertex_paygo.logs.preview.copy_failed": "Copy failed. Download the log.",
    "vertex_paygo.logs.preview.downloaded": "Log download started.",
    "vertex_paygo.logs.preview.download_failed": "Could not download the log.",
    "vertex_paygo.logs.field.errorCode": "Error code",
    "vertex_paygo.logs.field.statusCode": "HTTP status",
    "vertex_paygo.logs.field.durationMs": "Duration (ms)",
    "vertex_paygo.logs.field.model": "Model",
    "vertex_paygo.logs.field.provider": "Provider",
    "vertex_paygo.logs.field.tier": "Service tier",
    "vertex_paygo.logs.field.region": "Region",
    "vertex_paygo.logs.field.phase": "Phase",
    "vertex_paygo.logs.field.requestId": "Request ID",
    "vertex_paygo.logs.field.clientSessionId": "Client session ID",
    "vertex_paygo.logs.field.clientVersion": "Client version",
    "vertex_paygo.logs.field.protocolVersion": "Protocol version",
    "vertex_paygo.logs.field.stream": "Streaming",
    "vertex_paygo.logs.field.paygoOnly": "PayGo-only",
    "vertex_paygo.logs.field.serverStatus": "Server status",
    "vertex_paygo.logs.event.starting": "Plugin starting",
    "vertex_paygo.logs.event.host_loaded": "Host runtime loaded",
    "vertex_paygo.logs.event.ready": "Plugin ready",
    "vertex_paygo.logs.event.start_failed": "Plugin startup failed",
    "vertex_paygo.logs.event.cleanup_failed": "Startup cleanup failed",
    "vertex_paygo.logs.event.stopping": "Plugin stopping",
    "vertex_paygo.logs.event.stopped": "Plugin stopped",
    "vertex_paygo.logs.event.stop_failed": "Plugin shutdown failed",
    "vertex_paygo.logs.event.transport_starting": "Private transport starting",
    "vertex_paygo.logs.event.transport_ready": "Private transport ready",
    "vertex_paygo.logs.event.transport_failed": "Private transport startup failed",
    "vertex_paygo.logs.event.transport_stopped": "Private transport stopped",
    "vertex_paygo.logs.event.log_read_failed": "Log loading failed",
    "vertex_paygo.logs.event.preparing": "Request preparation started",
    "vertex_paygo.logs.event.prepared": "Request prepared",
    "vertex_paygo.logs.event.prepare_failed": "Request preparation failed",
    "vertex_paygo.logs.event.disconnected": "Client disconnected during preparation",
    "vertex_paygo.logs.event.ledger_create_failed": "Usage record creation failed",
    "vertex_paygo.logs.event.ledger_update_failed": "Usage record update failed",
    "vertex_paygo.logs.event.preview_failed": "Request structure capture failed",
    "vertex_paygo.logs.event.request_received": "Request received",
    "vertex_paygo.logs.event.forwarding": "Request forwarding started",
    "vertex_paygo.logs.event.log_full": "Runtime log capacity reached",
    "vertex_paygo.logs.event.client_log_full": "Client log capacity reached",
    "vertex_paygo.logs.event.client_starting": "Client extension starting",
    "vertex_paygo.logs.event.client_ready": "Client extension ready",
    "vertex_paygo.logs.event.client_failed": "Client extension startup failed",
    "vertex_paygo.logs.event.policy_refresh": "Model policy refresh started",
    "vertex_paygo.logs.event.policy_refreshed": "Model policy refreshed",
    "vertex_paygo.logs.event.policy_restored": "Saved policy restored",
    "vertex_paygo.logs.event.health_check": "Server health check started",
    "vertex_paygo.logs.event.health_ready": "Server health check completed",
    "vertex_paygo.logs.event.health_failed": "Server health check failed",
    "vertex_paygo.logs.event.log_loading": "Log loading started",
    "vertex_paygo.logs.event.log_loaded": "Log loaded",
    "vertex_paygo.logs.event.log_downloaded": "Log downloaded",
    "vertex_paygo.logs.event.log_download_failed": "Log download failed",
    "vertex_paygo.gemini4.server_upgrade": "Gemini 4 requires an updated server plugin. Update it and restart SillyTavern.",
    "vertex_paygo.gemini4.budget_exhausted": "Gemini 4 exhausted its output budget before returning text. Thinking tokens count toward Max Response Length; increase it or lower Reasoning Effort.",
    'vertex_paygo.gemini4.no_output': 'Gemini 4 returned no reply text (reason: {reason}).',
    'vertex_paygo.gemini4.upstream_error': 'Google rejected the Gemini 4 request (HTTP {status}): {message}',
    'vertex_paygo.google_error.summary': 'Google request failed (HTTP {status}): {diagnosis} Upstream details: {details}',
    'vertex_paygo.google_error.details_missing': 'The upstream returned no readable error details; the exact cause is unavailable.',
    'vertex_paygo.google_error.api_disabled': 'The required Google API is disabled for this project. Enable it in the project associated with this credential.',
    'vertex_paygo.google_error.billing_disabled': 'Billing is disabled or inactive for this project. Check its linked billing account.',
    'vertex_paygo.google_error.key_invalid': 'The API key is invalid or expired. Check the selected credential.',
    'vertex_paygo.google_error.key_restricted': 'The API key restrictions blocked this request. Check its allowed APIs, IP addresses and applications.',
    'vertex_paygo.google_error.iam_denied': 'This credential lacks the required IAM permission. Check the project and the account roles.',
    'vertex_paygo.google_error.permission_denied': 'Access was denied. Check the account permissions, model access and API key restrictions.',
    'vertex_paygo.google_error.unauthenticated': 'Authentication failed. Check the selected credential and refresh expired OAuth credentials.',
    'vertex_paygo.google_error.resource_missing': 'The requested resource was not found. Check the model, project, region and access permissions.',
    'vertex_paygo.google_error.resource_exhausted': 'The service reported exhausted quota or capacity. Check quota and retry later.',
    'vertex_paygo.google_error.invalid_request': 'A request parameter was rejected. See the upstream details to identify it.',
    'vertex_paygo.google_error.unavailable': 'The upstream service is temporarily unavailable. Retry later.',
    'vertex_paygo.google_error.upstream_failed': 'The upstream returned a server error. Retry later; check the network or proxy if it persists.',
    'vertex_paygo.google_error.unknown': 'The upstream rejected the request. See its error details.',
    'vertex_paygo.logs.event.request_failed': 'Model request failed',
    'vertex_paygo.logs.event.request_completed': 'Model request completed',
    'vertex_paygo.logs.event.upstream_response': 'Upstream response received',
    'vertex_paygo.logs.field.upstreamStatus': 'Upstream HTTP status',
    'vertex_paygo.logs.field.googleStatus': 'Google error status',
    'vertex_paygo.logs.field.googleReason': 'Google error reason',
    'vertex_paygo.logs.field.upstreamMessage': 'Upstream error message',
    'vertex_paygo.settings.tab.general': 'General',
    'vertex_paygo.settings.tab.pricing': 'Pricing',
    "vertex_paygo.settings.tab.logs": "Logs",
    "vertex_paygo.logs.permission_denied": "This account does not have permission to read runtime logs.",
    "vertex_paygo.logs.unavailable": "Runtime logs are unavailable. Check the server connection or refresh its status.",
    "vertex_paygo.logs.loading": "Loading runtime logs\u2026",
    'vertex_paygo.update.title': 'Component updates',
    'vertex_paygo.update.target_tag': '{component} → {tag}',
    'vertex_paygo.update.target_commit': '{component} → {branch} {commit}',
    'vertex_paygo.update.separator': '; ',
    'vertex_paygo.update.component.frontend': 'frontend extension',
    'vertex_paygo.update.component.server': 'server plugin',
    'vertex_paygo.update.held': '{component} is not updated: {reason}',
    "vertex_paygo.update.check": "Check for updates",
    "vertex_paygo.update.apply": "Install update",
    'vertex_paygo.update.checking': 'Checking both components…',
    'vertex_paygo.update.available': 'Update available: {components}',
    'vertex_paygo.update.uptodate': 'Both components are current.',
    'vertex_paygo.update.blocked': 'Update unavailable: {reason}',
    'vertex_paygo.update.running': 'Updating: {phase}…',
    "vertex_paygo.update.done": "Update complete. Restart SillyTavern and refresh the page to load the new version.",
    'vertex_paygo.update.failed': 'Update failed: {message}',
    'vertex_paygo.update.origin_mismatch': 'This copy was installed from another remote ({origin}); updates always come from the official repository.',
    'vertex_paygo.update.upgrade': 'Update the server plugin to enable component updates.',
    'vertex_paygo.update.phase.checking': 'checking the published release',
    'vertex_paygo.update.phase.preparing': 'downloading and verifying',
    'vertex_paygo.update.phase.activating': 'replacing files',
    "vertex_paygo.update.notice": "Components keep their update channels and files are backed up. Local changes or protocol conflicts may block updates. Restart SillyTavern afterwards.",
    "vertex_paygo.update.popup.title": "Update components",
    'vertex_paygo.update.popup.body': 'This will update {components}. The previous files are backed up, and the host must be restarted afterwards.',
    'vertex_paygo.update.popup.accept': 'Update now',
    'vertex_paygo.update.popup.decline': 'Cancel',
    "vertex_paygo.message_cost.recent_count": "Show costs for recent model replies",
    "vertex_paygo.message_cost.placement": "Message cost position",
    "vertex_paygo.message_cost.placement.footer": "Message footer",
    "vertex_paygo.message_cost.placement.header": "Message header (default)",
    "vertex_paygo.message_cost.placement.avatar": "Below avatar",
    "vertex_paygo.message_cost.placement.hidden": "Hidden",

    'vertex_paygo.costs.cache_hit_rate': 'Cache hit rate',
    'vertex_paygo.costs.cache_hit_rate_hint': 'Cached tokens / input tokens',
    "vertex_paygo.message_cost.label_amount": "≈ {amount}",
    "vertex_paygo.message_cost.label_partial": "Partial ≈ {amount}",
    "vertex_paygo.message_cost.label_cache_uncertain": "Cache discount unconfirmed ≈ {amount}",
    "vertex_paygo.message_cost.label_pending": "Calculating usage…",
    "vertex_paygo.message_cost.label_unpriced": "Awaiting pricing",
    "vertex_paygo.message_cost.label_unknown": "Cost unknown",
    "vertex_paygo.message_cost.dialog_label": "Message cost details",
    "vertex_paygo.message_cost.title": "Message usage and cost",
    "vertex_paygo.message_cost.estimate_complete": "Complete estimate",
    "vertex_paygo.message_cost.estimate_partial": "Partial estimate",
    "vertex_paygo.message_cost.close": "Close cost details",
    "vertex_paygo.message_cost.input": "Input",
    "vertex_paygo.message_cost.output_with_thinking": "Output (incl. thinking)",
    "vertex_paygo.message_cost.output_reported": "Output (reported)",
    "vertex_paygo.message_cost.output_breakdown": "Response {output} · Thinking {thinking}",
    "vertex_paygo.message_cost.thinking_unreported": "Thinking usage not reported",
    "vertex_paygo.message_cost.client_observed": "Observed by client",
    "vertex_paygo.message_cost.stream_timing_missing": "Incomplete stream timing",
    "vertex_paygo.message_cost.stream_only": "Streaming responses only",
    "vertex_paygo.message_cost.generation_speed": "Generation speed",
    "vertex_paygo.message_cost.local_cost": "Locally estimated cost",
    "vertex_paygo.message_cost.cost_unavailable": "Cannot estimate",
    "vertex_paygo.message_cost.current_price": "Includes current-price estimates",
    "vertex_paygo.message_cost.thinking": "Thinking tokens",
    "vertex_paygo.message_cost.cached": "Cached input",
    "vertex_paygo.message_cost.uncached": "Uncached input",
    "vertex_paygo.message_cost.first_content": "First content",
    "vertex_paygo.message_cost.first_content_unavailable": "Non-streaming or not observed",
    "vertex_paygo.message_cost.duration": "End-to-end duration",
    "vertex_paygo.message_cost.end_to_end_speed": "End-to-end speed",
    "vertex_paygo.message_cost.model_unknown": "Unknown model",
    "vertex_paygo.message_cost.tier_unknown": "Unknown tier",
    "vertex_paygo.message_cost.model_tier": "{model} · Tier: {tier}",
    "vertex_paygo.message_cost.request_count": "{count} requests",
    "vertex_paygo.message_cost.trigger_label": "View message cost: {cost}",
    "vertex_paygo.message_cost.unit_tokens": "tokens",
    "vertex_paygo.message_cost.unit_tps": "{value} tokens/s",
    "vertex_paygo.message_cost.unit_ms": "{value} ms",
    "vertex_paygo.message_cost.unit_seconds": "{value} s",
    "vertex_paygo.message_cost.reason.pending": "Request processing",
    "vertex_paygo.message_cost.reason.unavailable": "Usage polling ended without a result",
    "vertex_paygo.message_cost.reason.usage_missing": "The service did not report usage",
    "vertex_paygo.message_cost.reason.usage_incomplete": "The service reported incomplete usage",
    "vertex_paygo.message_cost.reason.cache_count_missing": "Cache count unavailable; this request is estimated without a cache discount",
    "vertex_paygo.message_cost.reason.cache_count_mixed": "Some subrequests lack cache counts; only known cache discounts are estimated",
    "vertex_paygo.message_cost.reason.cache_count_invalid": "Invalid cache count; this request is estimated without a cache discount",
    "vertex_paygo.message_cost.reason.tauri_normalized": "TauriTavern non-streaming usage may omit thinking and other details; cost is a partial estimate",
    "vertex_paygo.message_cost.reason.price_missing": "No price for this model and tier",
    "vertex_paygo.message_cost.reason.long_price_missing": "Long-context pricing unavailable",
    "vertex_paygo.message_cost.reason.traffic_tier_mismatch": "Reported traffic tier differs from the request",
    "vertex_paygo.message_cost.reason.provisioned_throughput": "PayGo estimates do not apply to Provisioned Throughput",
    "vertex_paygo.message_cost.reason.unsupported_modality": "Includes unsupported non-text modalities",
    "vertex_paygo.message_cost.reason.cache_exceeds_prompt": "Cached tokens exceed input tokens",
    "vertex_paygo.message_cost.reason.amount_out_of_range": "Cost is outside the representable range",
    "vertex_paygo.message_cost.reason.request_pending": "Request record pending",
    "vertex_paygo.message_cost.reason.request_incomplete": "Request record incomplete",
    "vertex_paygo.message_cost.reason.request_failed": "Request failed; cost may be incomplete",
    "vertex_paygo.message_cost.reason.tool_use": "Tool-use tokens may not be fully priced",
    "vertex_paygo.message_cost.reason.timing_missing": "Complete client timing unavailable",
    "vertex_paygo.tauri.request_blocked": "Native request failed: {message}",
    'vertex_paygo.tauri.title': `${EXTENSION_DISPLAY_NAME} · TauriTavern`,
    "vertex_paygo.tauri.native": "Uses TauriTavern native authentication and transport. No server plugin required.",
    'vertex_paygo.tauri.scope': "Configure:",
    "vertex_paygo.tauri.current": "Current Chat Completion connection",
    "vertex_paygo.tauri.refresh": "Refresh connections",
    "vertex_paygo.tauri.controls_missing": "TauriTavern extension settings not found.",
    "vertex_paygo.tauri.target_missing": "Selected Model Target not found. Refresh connections.",
    "vertex_paygo.tauri.select_google": "Select a Google Vertex AI or Google AI Studio connection to set its service tier.",
    "vertex_paygo.tauri.applied": "Native request tier: {tier}. Failed Flex requests are not retried as Standard.",
    "vertex_paygo.tauri.cost_notice": "TauriTavern non-streaming usage may omit thinking and other details, causing cost estimates to be too low.",
    "vertex_paygo.tauri.cost_coverage": "Records ordinary chat and compatible frontend requests, excluding native Agent/sub-Agent model loops. Non-streaming usage may omit thinking and other details, causing cost estimates to be too low.",
    "vertex_paygo.tauri.cancel": "Cancel",
    "vertex_paygo.tauri.settings_changed": "Connection settings changed during confirmation. Review the connection and select the tier again.",
    "vertex_paygo.tauri.yaml_missing": "Host YAML library unavailable. Cannot configure native request parameters.",
    "vertex_paygo.tauritavern.title": "TauriTavern compatibility APIs unavailable",
    "vertex_paygo.tauritavern.unavailable": "This build lacks required native parameter or extension storage APIs. Update to a compatible build (adapted for 2.3.0) and allow third-party extensions, or configure parameters manually below.",
    "vertex_paygo.tauritavern.vertex_title": "Google Vertex AI: Standard / Flex",
    "vertex_paygo.tauritavern.vertex_steps": "TauriTavern 2.1.0+: API Connections → Chat Completion → Google Vertex AI. Select a Flex-compatible Gemini model, set Region to global, and add this YAML in Additional Parameters → Include Request Headers:",
    'vertex_paygo.tauritavern.vertex_flex': 'X-Vertex-AI-LLM-Request-Type: shared\nX-Vertex-AI-LLM-Shared-Request-Type: flex',
    'vertex_paygo.tauritavern.ai_studio_title': 'Google AI Studio: Standard / Flex',
    "vertex_paygo.tauritavern.ai_studio_steps": "Select Google AI Studio, a paid Gemini API account, and a Flex-compatible model. Add this YAML in Additional Parameters → Include Body Parameters; no Vertex headers required:",
    'vertex_paygo.tauritavern.ai_studio_flex': 'service_tier: flex',
    "vertex_paygo.tauritavern.ai_studio_standard": "Remove service_tier to return to Standard. No Vertex region setting required.",
    "vertex_paygo.tauritavern.finish": "Parameters save automatically per API source. Preserve unrelated parameters and close when done. If fields are missing, update to TauriTavern 2.1.0+. Disable or uninstall the extension in Extensions.",
    "vertex_paygo.tauritavern.close": "Close",
    "vertex_paygo.costs.recording_unavailable": "This request was not recorded. Conversation cost totals may be incomplete.",
    'vertex_paygo.server_error.csrf': 'SillyTavern rejected the CSRF token (HTTP 403). Refresh the page and try again.',
    'vertex_paygo.server_error.http_non_json': 'Server plugin request failed (HTTP {status}); the server or reverse proxy returned no JSON error details.',
    'vertex_paygo.title': `${EXTENSION_DISPLAY_NAME} · Vertex AI`,
    'vertex_paygo.ai_studio.title': `${EXTENSION_DISPLAY_NAME} · AI Studio`,
    "vertex_paygo.ai_studio.guidance": "Flex uses discounted rates and may take longer. A paid Gemini API account is required. Failed requests are not retried as Standard.",
    "vertex_paygo.ai_studio.status": "{tier} uses Google AI Studio. No Vertex region setting required.",
    "vertex_paygo.ai_studio.tiers": "Google AI Studio supports Standard and Flex.",
    'vertex_paygo.service_tier': 'Service tier:',
    'vertex_paygo.tier.standard': 'Standard',
    'vertex_paygo.tier.flex': 'Flex',
    'vertex_paygo.tier.priority': 'Priority',
    "vertex_paygo.server.checking": "Checking server…",
    "vertex_paygo.server.ready": "Server ready · {version}",
    'vertex_paygo.server.ready_detail': 'Protocol v2, loopback HTTP transport and usage ledger',
    "vertex_paygo.server.unavailable": "Server unavailable",
    "vertex_paygo.retry": "Refresh status",
    "vertex_paygo.logs.view": "View logs",
    "vertex_paygo.logs.save": "Download logs",
    "vertex_paygo.logs.title": "Runtime logs",
    "vertex_paygo.logs.description": "Client and server events from this session. Review before sharing.",
    "vertex_paygo.logs.close": "Close",
    "vertex_paygo.logs.empty": "No logs for this server session.",
    "vertex_paygo.logs.view_failed": "Could not load logs: {error}",
    "vertex_paygo.logs.save_failed": "Could not download logs: {error}",
    "vertex_paygo.status.model_unresolved": "Waiting for Google model information…",
    "vertex_paygo.status.non_gemini": "PayGo tier controls are unavailable for non-Gemini models.",
    "vertex_paygo.status.blocked": "Request blocked: {message}",
    "vertex_paygo.status.tier_global": "{tier} PayGo uses the global endpoint.",
    "vertex_paygo.error.persist": "Could not save PayGo settings: {error}",
    "vertex_paygo.error.controls_missing": "Vertex AI settings controls not found.",
    "vertex_paygo.error.controls_timeout": "Timed out waiting for Vertex AI settings controls.",
    "vertex_paygo.error.context_unavailable": "SillyTavern extension context unavailable.",
    "vertex_paygo.error.paygo_only_gemini": "PayGo-only supports Gemini models only.",
    "vertex_paygo.policy.gemini_only": "PayGo tier controls support native Gemini model IDs (gemini-*) only.",
    "vertex_paygo.policy.native_standard": "Standard Gemini requests use the server to record usage without changing the service tier.",
    "vertex_paygo.policy.known": "Supports {tier} PayGo as of {date}.",
    "vertex_paygo.policy.unsupported": "The {date} support snapshot does not list this model for {tier} PayGo.",
    "vertex_paygo.policy.unverified": "This model is not in the {date} support snapshot. Google performs final validation.",
    "vertex_paygo.validation.non_gemini": "PayGo tier controls are unavailable for non-Gemini models.",
    "vertex_paygo.validation.global_required": "{tier} PayGo requires the global Vertex AI endpoint.",
    "vertex_paygo.popup.tier_region.title": "{tier} PayGo requires global",
    "vertex_paygo.popup.tier_region.body": "Current Vertex AI region: “{region}”. Switch to global with the selected tier, or keep the region with Standard.",
    "vertex_paygo.popup.tier_region.accept": "Use global and {tier}",
    "vertex_paygo.popup.tier_region.decline": "Keep region and use Standard",
    "vertex_paygo.popup.region.title": "Regional endpoints use Standard",
    "vertex_paygo.popup.region.body": "{tier} PayGo requires global. Use the new region with Standard, or keep global and the current tier.",
    "vertex_paygo.popup.region.accept": "Use new region and Standard",
    "vertex_paygo.popup.region.decline": "Keep global and {tier}",
    "vertex_paygo.popup.model.reason_gemini": "PayGo tier controls support Gemini models only.",
    "vertex_paygo.popup.model.reason_unsupported": "The selected model does not support this PayGo tier.",
    "vertex_paygo.popup.model.title": "Model and PayGo tier incompatible",
    "vertex_paygo.popup.model.body": "{reason} Use the new model with Standard, or restore the previous model and PayGo setting.",
    "vertex_paygo.popup.model.accept": "Use new model and Standard",
    "vertex_paygo.popup.model.decline": "Restore previous model",
    "vertex_paygo.popup.saved.title": "Saved PayGo settings incompatible",
    "vertex_paygo.popup.saved.body": "{message} Switch to Standard, or keep the blocked settings until the model is changed.",
    "vertex_paygo.popup.saved.accept": "Use Standard",
    "vertex_paygo.popup.saved.decline": "Keep current settings",
    "vertex_paygo.hook.proxy_conflict": "Prompt Cache Optimization is incompatible with a custom reverse proxy. Disable it before generating.",
    "vertex_paygo.hook.request_blocked": "{message} Request blocked; not sent to Google.",
    "vertex_paygo.server_error.invalid_proxy_url": "Server plugin returned an invalid proxy URL.",
    "vertex_paygo.server_error.unsafe_proxy_url": "Server proxy URL must be an authenticated loopback HTTP endpoint.",
    "vertex_paygo.server_error.invalid_response": "Server plugin returned a non-JSON response.",
    "vertex_paygo.server_error.invalid_log_response": "Server plugin returned an invalid log response.",
    "vertex_paygo.server_error.log_too_large": "Server log exceeds the {size} limit.",
    "vertex_paygo.server_error.http": "Server request failed: {message}",
    "vertex_paygo.server_error.timeout": "Timed out waiting for the server plugin.",
    "vertex_paygo.server_error.unavailable": "Server plugin unavailable.",
    "vertex_paygo.server_error.protocol": "Server plugin protocol v{version} required.",
    "vertex_paygo.server_error.transport": "Server transport “{transport}” required.",
    "vertex_paygo.server_error.ticket": "Server ticket does not match its proxy URL.",
    "vertex_paygo.server_error.secret": "Server plugin returned an invalid proxy secret.",

    "vertex_paygo.error_code.authenticated_user_required": "An authenticated SillyTavern user is required.",
    "vertex_paygo.error_code.gemini4_upstream_http_error": "Google rejected the Gemini 4 request.",
    "vertex_paygo.error_code.client_disconnected": "The client disconnected.",
    "vertex_paygo.error_code.request_body_too_large": "The proxied Google request body is too large.",
    "vertex_paygo.error_code.invalid_google_body": "The Google request must be a JSON object.",
    "vertex_paygo.error_code.vertex_upstream_timeout": "The Google upstream request timed out.",
    "vertex_paygo.error_code.gemini4_compressed_response": "The Google upstream returned unsupported compressed data.",
    "vertex_paygo.error_code.gemini4_upstream_error": "The Google upstream returned an error.",
    "vertex_paygo.error_code.gemini4_response_too_large": "The Google response exceeded the transport limit.",
    "vertex_paygo.error_code.gemini4_incomplete_response": "The Google stream ended without a terminal finish reason.",
    "vertex_paygo.error_code.gemini4_continuation_token_missing": "The Google continuation response did not include a token.",
    "vertex_paygo.error_code.gemini4_continuation_budget_unknown": "The Google continuation cannot proceed without an explicit output budget and output usage.",
    "vertex_paygo.error_code.gemini4_continuation_limit": "The Google continuation limit was reached.",
    "vertex_paygo.error_code.paygo_only_removed": "Force PayGo-only has been removed; refresh the frontend or remove the legacy option.",
    "vertex_paygo.error_code.priority_removed": "Priority has been removed; use Standard or Flex.",
    "vertex_paygo.error_code.invalid_header_policy": "The PayGo header policy received invalid state.",
    "vertex_paygo.error_code.incompatible_sillytavern": "The host secret reader is unavailable.",
    "vertex_paygo.error_code.incompatible_host_secret_manager": "This legacy host lacks the required by-ID SecretManager interface.",
    "vertex_paygo.error_code.explicit_secret_unsupported": "The selected credential ID is invalid.",
    "vertex_paygo.error_code.explicit_secret_unavailable": "The host credential could not be read.",
    "vertex_paygo.error_code.log_access_forbidden": "Administrator access is required to read the shared server log.",
    "vertex_paygo.error_code.client_log_access_forbidden": "Administrator access is required to write the shared server log.",
    "vertex_paygo.error_code.client_log_media_type_required": "The client log content type is invalid.",
    "vertex_paygo.error_code.invalid_client_log_event": "The client log content length is invalid.",
    "vertex_paygo.error_code.client_log_event_too_large": "The client log event is too large.",
    "vertex_paygo.error_code.log_read_failed": "The 提示词缓存优化 log could not be read.",
    "vertex_paygo.error_code.loopback_bind_failed": "The private loopback proxy could not be started.",
    "vertex_paygo.error_code.loopback_not_ready": "The private loopback proxy is not ready.",
    "vertex_paygo.error_code.gemini4_output_budget_exhausted": "Gemini 4 used the whole output budget before writing reply text. Thinking tokens count toward the maximum response length; raise it or lower the reasoning effort.",
    "vertex_paygo.error_code.native_gemini_empty_response": "Native Gemini returned no reply text.",
    "vertex_paygo.error_code.native_gemini_upstream_failed": "Native Gemini generation failed.",
    "vertex_paygo.error_code.native_gemini_model_unsupported": "Native Gemini generation requires a supported Gemini 4 model.",
    "vertex_paygo.error_code.native_gemini_source_unsupported": "Native Gemini generation requires a Google source.",
    "vertex_paygo.error_code.invalid_request": "The generation request parameters are invalid.",
    "vertex_paygo.error_code.invalid_proxy_target": "The prepared local proxy target is invalid.",
    "vertex_paygo.error_code.native_gemini_invalid_response": "Native Gemini returned a stream event that is too large.",
    "vertex_paygo.error_code.native_gemini_failed": "Native Gemini generation could not be completed.",
    "vertex_paygo.error_code.native_relay_unsupported": "Final native request capture is unavailable for this configuration.",
    "vertex_paygo.error_code.invalid_native_prepare": "Invalid native request preparation metadata.",
    "vertex_paygo.error_code.invalid_native_proxy_path": "The native proxy path is invalid.",
    "vertex_paygo.error_code.native_relay_request_failed": "The native request stream failed.",
    "vertex_paygo.error_code.method_not_allowed": "Only POST is accepted by the native relay.",
    "vertex_paygo.error_code.native_proxy_mismatch": "The native proxy request does not match its ticket.",
    "vertex_paygo.error_code.native_relay_redirect_rejected": "The native relay does not follow upstream redirects.",
    "vertex_paygo.error_code.native_relay_response_failed": "The native upstream response headers are invalid.",
    "vertex_paygo.error_code.native_relay_upstream_failed": "The native upstream connection failed.",
    "vertex_paygo.error_code.native_relay_upstream_timeout": "The native upstream request timed out.",
    "vertex_paygo.error_code.invalid_native_ticket": "Invalid native relay ticket.",
    "vertex_paygo.error_code.invalid_prompt_inspector_scope": "Invalid prompt inspector model.",
    "vertex_paygo.error_code.prompt_inspector_unavailable": "Prompt inspector is unavailable.",
    "vertex_paygo.error_code.native_prompt_capture_unavailable": "Final outbound capture is unavailable for this provider. Frontend request messages can be inspected without host changes.",
    "vertex_paygo.error_code.prompt_inspector_capacity": "Temporary prompt inspector capacity is exhausted.",
    "vertex_paygo.error_code.invalid_prompt_inspector_query": "Invalid prompt inspector ticket.",
    "vertex_paygo.error_code.invalid_prepare_request": "The request preparation parameters are invalid.",
    "vertex_paygo.error_code.invalid_worldinfo_order_plan": "Invalid bounded world-info order plan.",
    "vertex_paygo.error_code.protocol_mismatch": "The frontend and server protocol versions are incompatible.",
    "vertex_paygo.error_code.google_only": "Only the Vertex AI and Google AI Studio sources are supported.",
    "vertex_paygo.error_code.upstream_proxy_unsupported": "Existing reverse-proxy settings are not accepted by this transport.",
    "vertex_paygo.error_code.invalid_reverse_proxy": "The AI Studio reverse proxy must be an HTTP(S) base URL without credentials, query or fragment.",
    "vertex_paygo.error_code.invalid_proxy_password": "The AI Studio proxy password is invalid.",
    "vertex_paygo.error_code.model_unsupported": "Vertex AI Flex does not support Gemini 4 models. Use Standard.",
    "vertex_paygo.error_code.global_region_required": "Flex requires the global Vertex AI region.",
    "vertex_paygo.error_code.invalid_proxy_secret": "The proxy credential is invalid.",
    "vertex_paygo.error_code.invalid_proxy_path": "The proxy path is invalid.",
    "vertex_paygo.error_code.proxy_request_mismatch": "The proxy request does not match its ticket.",
    "vertex_paygo.error_code.json_required": "The loopback proxy accepts JSON request bodies only.",
    "vertex_paygo.error_code.vertex_redirect_rejected": "The Vertex AI upstream returned a redirect, which was not followed.",
    "vertex_paygo.error_code.vertex_upstream_failed": "The Vertex AI upstream connection failed.",
    "vertex_paygo.error_code.proxy_request_stream_failed": "The loopback request stream failed.",
    "vertex_paygo.error_code.native_order_unavailable": "Native world-info ordering is unavailable.",
    "vertex_paygo.error_code.paygo_request_blocked": "The 提示词缓存优化 request was blocked before proxy preparation completed.",
    "vertex_paygo.error_code.unsafe_google_target": "SillyTavern returned an invalid Google endpoint.",
    "vertex_paygo.error_code.unsafe_google_headers": "SillyTavern returned invalid Vertex AI headers.",
    "vertex_paygo.error_code.ticket_capacity_exceeded": "The proxy ticket capacity is temporarily exhausted.",
    "vertex_paygo.error_code.user_ticket_capacity_exceeded": "This user has too many pending proxy tickets.",
    "vertex_paygo.error_code.ticket_issue_rate_exceeded": "Proxy ticket issuance is temporarily rate limited.",
    "vertex_paygo.error_code.ticket_reservation_invalid": "The proxy ticket reservation is invalid or has expired.",
    "vertex_paygo.error_code.ticket_reservation_expired": "The proxy ticket reservation has expired.",
    "vertex_paygo.error_code.ticket_generation_failed": "Could not allocate a proxy ticket.",
    "vertex_paygo.error_code.invalid_proxy_ticket": "The proxy ticket is invalid or has already been used.",
    "vertex_paygo.error_code.expired_proxy_ticket": "The proxy ticket has expired.",
    "vertex_paygo.error_code.updater_vendor_unavailable": "The bundled Git implementation is missing or incomplete.",
    "vertex_paygo.error_code.updater_git_failed": "The Git update operation failed. Check the network and repository status.",
    "vertex_paygo.error_code.updater_invalid_metadata": "The PayGo updater metadata could not be read as a JSON object.",
    "vertex_paygo.error_code.updater_payload_mismatch": "The prepared frontend copy is not the 提示词缓存优化 extension.",
    "vertex_paygo.error_code.updater_payload_incomplete": "The prepared server copy is missing its main entry point.",
    "vertex_paygo.error_code.updater_payload_symlink": "The prepared update contains a symbolic link.",
    "vertex_paygo.error_code.updater_component_missing": "The component was not found in the host installation.",
    "vertex_paygo.error_code.updater_component_ambiguous": "Several copies of this component were found. Remove the extra copies before updating.",
    "vertex_paygo.error_code.updater_protocol_mismatch": "The component updates would use incompatible protocol versions. Update both components together.",
    "vertex_paygo.error_code.updater_in_progress": "An update is already running.",
    "vertex_paygo.error_code.updater_component_blocked": "This component cannot be updated.",
    "vertex_paygo.error_code.updater_installation_changed": "The installation changed while preparing the update. Check for updates again.",
    "vertex_paygo.error_code.updater_unsafe_path": "External plugin directories must share the configured data root and contain the running server plugin.",
    "vertex_paygo.error_code.updater_host_paths_unavailable": "The host has not published its resolved data and configuration paths.",
    "vertex_paygo.error_code.updater_access_forbidden": "Administrator access is required to update the 提示词缓存优化 components.",
    "vertex_paygo.error_code.local_preview_updates_disabled": "This local preview must be updated from its explicit local build, not the upstream updater.",
    "vertex_paygo.error_code.updater_busy": "Another installation or update is already running, or its lock directory remains.",
    "vertex_paygo.error_code.updater_lock_failed": "The update lock could not be created.",
    "vertex_paygo.error_code.updater_activation_failed": "The prepared update could not be activated. Check the runtime log for recovery details.",
    "vertex_paygo.error_code.updater_invalid_ref": "The selected Git branch or tag name is invalid.",
    "vertex_paygo.error_code.updater_unknown_tag_shape": "The selected commit has a tag outside the supported vMAJOR.MINOR.PATCH format.",
    "vertex_paygo.error_code.updater_no_history": "The selected branch history is required to resolve the newest release tag.",
    "vertex_paygo.error_code.updater_no_tag": "No release tag is available for the selected branch.",
    "vertex_paygo.error_code.updater_no_reachable_tag": "No release tag is reachable from the selected branch.",
    "vertex_paygo.error_code.updater_channel_unknown": "This installation does not record which release channel it follows. Run the installer once to record it, then retry.",
    "vertex_paygo.error_code.updater_not_installed": "No installed Git revision was found for this component.",
    "vertex_paygo.error_code.updater_no_branch_head": "The selected branch has no head revision.",
    "vertex_paygo.error_code.updater_no_target": "The updater did not resolve a target release.",
    "vertex_paygo.error_code.updater_local_changes": "Local changes prevent this update. Back up the files and use the installer to replace them.",
    "vertex_paygo.error_code.updater_local_commits": "The installed copy contains commits that are not on the selected branch. Use the installer with --replace-modified to back them up and replace them.",
    "vertex_paygo.error_code.updater_older_or_divergent": "The selected revision is older than or divergent from the installed revision.",
    "vertex_paygo.error_code.invalid_usage_page": "Invalid preview selection.",
    "vertex_paygo.error_code.request_preview_feature_unavailable": "The backend cannot read a bounded preview page.",
    "vertex_paygo.error_code.internal_error": "The Prompt Cache Optimization server plugin could not complete the request. See the runtime log for details.",
    "vertex_paygo.error_code.invalid_update_response": "The server returned an invalid update response.",
    "vertex_paygo.error_code.invalid_usage_response": "The server returned invalid usage records.",
    "vertex_paygo.error_code.invalid_inspector_response": "The prompt snapshot response is invalid.",
    "vertex_paygo.network_error.etimedout": "The forwarded request timed out ({code}). Retry later or check your network and proxy connection.",
    "vertex_paygo.network_error.esockettimedout": "The forwarded request timed out ({code}). Retry later or check your network and proxy connection.",
    "vertex_paygo.network_error.und_err_connect_timeout": "Connecting to the server timed out ({code}). Retry later or check your network and proxy connection.",
    "vertex_paygo.network_error.und_err_headers_timeout": "Waiting for the server response timed out ({code}). Retry later or check your network and proxy connection.",
    "vertex_paygo.network_error.und_err_body_timeout": "Reading the server response timed out ({code}). Retry later or check your network and proxy connection.",
    "vertex_paygo.network_error.econnreset": "The request connection was interrupted ({code}). Retry later or check your network and proxy connection.",
    "vertex_paygo.network_error.econnrefused": "The request connection was refused ({code}). Retry later or check your network and proxy connection.",
    "vertex_paygo.network_error.enotfound": "The request hostname could not be resolved ({code}). Retry later or check your network and proxy connection.",
    "vertex_paygo.network_error.eai_again": "The request hostname could not be resolved temporarily ({code}). Retry later or check your network and proxy connection.",
    "vertex_paygo.error_code.explicit_secret_not_found": "The selected credential was not found. Check the credential selection.",
});

export function formatMessage(message, parameters = {}) {
    return String(message).replace(/\{([a-zA-Z0-9_]+)\}/gu, (match, name) => (
        Object.hasOwn(parameters, name) ? String(parameters[name]) : match
    ));
}

export function createLocalizer(translate = undefined) {
    const translateImpl = typeof translate === 'function' ? translate : (fallback => fallback);
    return (key, parameters = {}) => {
        const fallback = MESSAGES[key] ?? key;
        let localized = fallback;
        try {
            const translated = translateImpl(fallback, key);
            if (typeof translated === 'string' && translated.length > 0) {
                localized = translated;
            }
        } catch {

        }
        return formatMessage(localized, parameters);
    };
}

export function getTierLabel(localize, tier) {
    const key = `vertex_paygo.tier.${tier}`;
    return localize(key);
}

export function localizeSupport(localize, support, tier) {
    const tierLabel = getTierLabel(localize, tier);
    const snapshot = support?.snapshot ?? MODEL_POLICY_SNAPSHOT;
    switch (support?.level) {
        case 'unavailable':
            return localize('vertex_paygo.ai_studio.tiers');
        case 'excluded':
            return localize('vertex_paygo.policy.gemini_only');
        case 'native':
            return localize('vertex_paygo.policy.native_standard');
        case 'known':
            return localize('vertex_paygo.policy.known', { tier: tierLabel, date: snapshot });
        case 'unsupported':
            return localize('vertex_paygo.policy.unsupported', { tier: tierLabel, date: snapshot });
        case 'unverified':
            return localize('vertex_paygo.policy.unverified', { date: snapshot });
        default:
            return String(support?.reason ?? '');
    }
}

export function localizeValidation(localize, validation, state = undefined) {
    switch (validation?.code) {
        case 'PAYGO_REQUIRES_GEMINI':
            return localize('vertex_paygo.validation.non_gemini');
        case 'MODEL_UNSUPPORTED':
            return localizeSupport(localize, validation.support, state?.tier);
        case 'TIER_REQUIRES_GLOBAL':
            return localize('vertex_paygo.validation.global_required', {
                tier: getTierLabel(localize, state?.tier),
            });
        default:
            return String(validation?.message ?? '');
    }
}

const KEY_BY_ERROR_CODE = Object.freeze({
    PAYGO_ONLY_REMOVED: 'vertex_paygo.server_error.paygo_only_removed',
    PRIORITY_REMOVED: 'vertex_paygo.server_error.priority_removed',
    CSRF_REJECTED: 'vertex_paygo.server_error.csrf',
    INVALID_PROXY_URL: 'vertex_paygo.server_error.invalid_proxy_url',
    UNSAFE_PROXY_URL: 'vertex_paygo.server_error.unsafe_proxy_url',
    INVALID_RESPONSE: 'vertex_paygo.server_error.invalid_response',
    INVALID_LOG_RESPONSE: 'vertex_paygo.server_error.invalid_log_response',
    LOG_TOO_LARGE: 'vertex_paygo.server_error.log_too_large',
    TIMEOUT: 'vertex_paygo.server_error.timeout',
    UNAVAILABLE: 'vertex_paygo.server_error.unavailable',
    PROTOCOL_MISMATCH: 'vertex_paygo.server_error.protocol',
    TRANSPORT_MISMATCH: 'vertex_paygo.server_error.transport',
    INVALID_PROXY_TICKET: 'vertex_paygo.server_error.ticket',
    INVALID_PROXY_SECRET: 'vertex_paygo.server_error.secret',
});

export function localizePluginErrorMessage(localize, error,
    { protocolVersion = PROTOCOL_VERSION, transport = REQUIRED_TRANSPORT } = {}) {
    if (typeof localize !== 'function' || typeof error?.code !== 'string') return null;
    const details = error.details && typeof error.details === 'object' ? error.details : {};
    const rawNetworkKey = 'vertex_paygo.network_error.' + error.code.toLowerCase();
    if (Object.hasOwn(MESSAGES, rawNetworkKey)) return localize(rawNetworkKey, { code: error.code });
    const key = KEY_BY_ERROR_CODE[error.code] ?? 'vertex_paygo.error_code.' + error.code.toLowerCase();
    if (!Object.hasOwn(MESSAGES, key)) return null;
    if (typeof details.networkCode === 'string') {
        const networkKey = 'vertex_paygo.network_error.' + details.networkCode.toLowerCase();
        if (Object.hasOwn(MESSAGES, networkKey)) return localize(networkKey, { code: details.networkCode });
    }
    if (error.code === 'GEMINI4_UPSTREAM_HTTP_ERROR') {
        const message = localizeGoogleUpstreamError(localize, details, error.status);
        if (message) return message;
    }
    if (error.code === 'NATIVE_GEMINI_EMPTY_RESPONSE') {
        return localize('vertex_paygo.gemini4.no_output', { reason: details.reason ?? 'UNKNOWN' });
    }
    const translated = localize(key, { version: protocolVersion, transport, size: '5 MiB' });
    // Preserve current servers' specific Chinese diagnoses, including fields and paths.
    if (error.code !== 'INTERNAL_ERROR' && typeof error.message === 'string'
        && /\p{Script=Han}/u.test(translated) && /\p{Script=Han}/u.test(error.message)
        && !/^\s*(?:The|This|Server Plugin|Native Gemini|An|A)\b/u.test(error.message)) return error.message;
    return translated;
}

export function localizeError(
    localize,
    error,
    { protocolVersion = PROTOCOL_VERSION, transport = REQUIRED_TRANSPORT } = {},
) {
    if (error?.localized && typeof error.message === 'string') return error.message;
    if (error?.code === 'HTTP_ERROR') {
        if (error.responseFormat === 'non-json') return localize('vertex_paygo.server_error.http_non_json', { status: error.status });
        const details = [error.status ? `HTTP ${error.status}` : '', error.serverCode].filter(Boolean).join(' / ');
        const message = localizePluginErrorMessage(localize, {
            code: error.serverCode, message: error.message, details: error.details,
        }, { protocolVersion, transport }) ?? (typeof error.message === 'string' ? error.message : String(error));
        return localize('vertex_paygo.server_error.http', {
            message: `${message}${details ? ` (${details})` : ''}`,
        });
    }

    const message = localizePluginErrorMessage(localize, error, { protocolVersion, transport });
    if (message) return message;
    return typeof error?.message === 'string' ? error.message : String(error);
}
