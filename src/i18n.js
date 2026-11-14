/*
 * Copyright (c) 2026 Mana Nekoha
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { EXTENSION_DISPLAY_NAME, PROTOCOL_VERSION, REQUIRED_TRANSPORT } from './constants.js';
import { MODEL_POLICY_SNAPSHOT } from './model-policy.js';

export const MESSAGES = Object.freeze({
    "vertex_paygo.tier.guide.summary": "Service tier guide",
    "vertex_paygo.tier.guide.order": "Actual extension request tier: Standard (default choice) > Flex (cost-first)",
    "vertex_paygo.tier.guide.standard": "- Standard: Standard tier, used by default.",
    "vertex_paygo.tier.guide.flex": "- Flex: Lower priority and discounted rates; busy periods may mean longer waits or failures. Suitable when waiting is acceptable to reduce cost.",
    "vertex_paygo.tier.guide.vertex_limits": "- Limits: Available tiers depend on the current model. Vertex Flex requires the global endpoint. A failed Flex request does not automatically retry using Standard.",
    "vertex_paygo.tier.guide.studio_limits": "- Limits: Available tiers depend on the current model. AI Studio Flex requires a paid account. A failed Flex request does not automatically retry using Standard.",
    "vertex_paygo.server_error.priority_removed": "Priority has been removed. Refresh the frontend and use Standard or Flex.",
    "vertex_paygo.tier.name.standard": "Standard",
    "vertex_paygo.tier.name.flex": "Flex",
    "vertex_paygo.tier.name.priority": "Priority",
    "vertex_paygo.tier.description.standard": "Regular priority and standard rates, suitable for everyday chat.",
    "vertex_paygo.tier.description.flex": "Discounted rates with lower priority; busy periods may mean longer waits or failed requests. Choose it when waiting is acceptable and lower cost matters.",
    "vertex_paygo.tier.note.vertex_global": "Options follow the current model support information. Vertex Flex require the global endpoint.",
    "vertex_paygo.tier.note.ai_studio_paid": "Options follow the current model support information. AI Studio Flex requires a paid account; no Vertex region is needed.",
    "vertex_paygo.tier.note.unverified": "For options marked unverified, confirm Google’s actual support.",
    "vertex_paygo.tier.note.flex_failure": "If a Flex request fails, the extension does not automatically retry using Standard.",
    "vertex_paygo.tier.unverified": "Unverified",
    "vertex_paygo.tier.choose_supported": "Choose a supported tier",
    "vertex_paygo.tier.restore_standard": "Use Standard",
    "vertex_paygo.guidance.standard_only": "The current support table lists only Standard for this model.",
    "vertex_paygo.guidance.vertex_supported": "Only tiers supported by this model are listed. Flex may cost less but take longer; Vertex Flex require global.",
    "vertex_paygo.guidance.ai_studio_supported": "Only tiers supported by this model are listed. AI Studio Flex requires a paid account; no Vertex region is needed.",
    "vertex_paygo.guidance.vertex_unverified": "Extended tiers for this model are unverified. Confirm Google support; Vertex Flex require global.",
    "vertex_paygo.guidance.ai_studio_unverified": "AI Studio Flex support for this model is unverified; confirm provider support before selecting it.",
    "vertex_paygo.server_error.paygo_only_removed": "Force PayGo-only has been removed. Refresh the frontend to clear the obsolete option.",
    "vertex_paygo.guidance": "Only tiers supported by this model are listed. Flex may cost less but take longer; Vertex Flex require global.",
    "vertex_paygo.status.native_standard": "Standard collects returned token usage without changing the provider tier.",
    "vertex_paygo.tauri.persistence": "Changes are saved in native Additional Parameters or the selected Model Target. Return to Standard before disabling this extension to clear managed tier headers.",
    "vertex_paygo.tauritavern.vertex_tiers": "Use Flex for lower cost. Return to Standard by removing managed tier headers, including legacy force-shared headers.",
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
    "vertex_paygo.logs.preview.unparsed": "This line could not be interpreted as a log event. Its original text is retained.",
    "vertex_paygo.logs.preview.oversized": "This line exceeds the preview parsing limit. Its original text is retained.",
    "vertex_paygo.logs.preview.more_fields": "Additional fields are available in the original JSON.",
    "vertex_paygo.logs.preview.count": "Showing {shown} of {matched} matches · {total} entries total, newest first",
    "vertex_paygo.logs.preview.no_matches": "No matching log entries.",
    "vertex_paygo.logs.preview.limit": "Preview covers the latest {count} of {total} entries. Original view and download retain the complete file.",
    "vertex_paygo.logs.preview.raw_hint": "Complete original log. Search and level filters apply only to preview.",
    "vertex_paygo.logs.preview.page": "{page} / {pages}",
    "vertex_paygo.logs.preview.pages": "Log pages",
    "vertex_paygo.logs.preview.previous": "Previous page",
    "vertex_paygo.logs.preview.next": "Next page",
    "vertex_paygo.logs.preview.copy_raw": "Copy original log",
    "vertex_paygo.logs.preview.download_raw": "Download original log",
    "vertex_paygo.logs.preview.copied": "Original log copied.",
    "vertex_paygo.logs.preview.copy_failed": "Could not copy. Download the original log instead.",
    "vertex_paygo.logs.preview.downloaded": "Original log download requested.",
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
    'vertex_paygo.gemini4.server_upgrade': 'Gemini 4 compatibility requires the updated server plugin. Update the server plugin and restart SillyTavern.',
    'vertex_paygo.gemini4.budget_exhausted': 'Gemini 4 used the whole output budget before writing any reply text. Thinking tokens count toward Max Response Length: raise it or lower the Reasoning Effort.',
    'vertex_paygo.gemini4.no_output': 'Gemini 4 returned no reply text (reason: {reason}).',
    'vertex_paygo.gemini4.upstream_error': 'Google rejected the Gemini 4 request (HTTP {status}): {message}',
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
    'vertex_paygo.update.done': 'Updated. Restart the host and refresh this page to load the new version; the one running now is still the previous one.',
    'vertex_paygo.update.failed': 'Update failed: {message}',
    'vertex_paygo.update.origin_mismatch': 'This copy was installed from another remote ({origin}); updates always come from the official repository.',
    'vertex_paygo.update.upgrade': 'Update the Server Plugin to manage component updates from this panel.',
    'vertex_paygo.update.phase.checking': 'checking the published release',
    'vertex_paygo.update.phase.preparing': 'downloading and verifying',
    'vertex_paygo.update.phase.activating': 'replacing files',
    "vertex_paygo.update.notice": "Each component keeps its update channel. Files are backed up; local changes or protocol conflicts may block an update. Restart the host afterwards.",
    'vertex_paygo.update.popup.title': `Update ${EXTENSION_DISPLAY_NAME} components?`,
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
    "vertex_paygo.message_cost.label_pending": "Estimating cost",
    "vertex_paygo.message_cost.label_unpriced": "Price needed",
    "vertex_paygo.message_cost.label_unknown": "Cost unknown",
    "vertex_paygo.message_cost.dialog_label": "Message cost details",
    "vertex_paygo.message_cost.title": "Message usage and cost",
    "vertex_paygo.message_cost.estimate_complete": "Complete estimate",
    "vertex_paygo.message_cost.estimate_partial": "Available estimate",
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
    "vertex_paygo.message_cost.tier_unknown": "Unknown",
    "vertex_paygo.message_cost.model_tier": "{model} · Tier: {tier}",
    "vertex_paygo.message_cost.request_count": "Requests: {count}",
    "vertex_paygo.message_cost.trigger_label": "View message cost: {cost}",
    "vertex_paygo.message_cost.unit_tokens": "tokens",
    "vertex_paygo.message_cost.unit_tps": "{value} tokens/s",
    "vertex_paygo.message_cost.unit_ms": "{value} ms",
    "vertex_paygo.message_cost.unit_seconds": "{value} s",
    "vertex_paygo.message_cost.reason.pending": "Request is still processing",
    "vertex_paygo.message_cost.reason.unavailable": "Usage polling ended without a result",
    "vertex_paygo.message_cost.reason.usage_missing": "The service did not report usage",
    "vertex_paygo.message_cost.reason.usage_incomplete": "The service reported incomplete usage",
    "vertex_paygo.message_cost.reason.tauri_normalized": "TauriTavern non-streaming usage is normalized and may omit thinking or other details; this is a partial cost estimate",
    "vertex_paygo.message_cost.reason.price_missing": "No price for this model and tier",
    "vertex_paygo.message_cost.reason.long_price_missing": "Long-context pricing is unavailable",
    "vertex_paygo.message_cost.reason.traffic_tier_mismatch": "Reported traffic tier differs from the request",
    "vertex_paygo.message_cost.reason.provisioned_throughput": "Provisioned Throughput cannot be estimated with PayGo prices",
    "vertex_paygo.message_cost.reason.unsupported_modality": "Includes non-text modalities not supported by this estimate",
    "vertex_paygo.message_cost.reason.cache_exceeds_prompt": "Cached tokens exceed input tokens",
    "vertex_paygo.message_cost.reason.amount_out_of_range": "Cost is outside the representable range",
    "vertex_paygo.message_cost.reason.request_pending": "Request record is not complete yet",
    "vertex_paygo.message_cost.reason.request_incomplete": "Request record is incomplete",
    "vertex_paygo.message_cost.reason.request_failed": "Request failed; cost may be incomplete",
    "vertex_paygo.message_cost.reason.tool_use": "Tool-use tokens may not be fully priced",
    "vertex_paygo.message_cost.reason.timing_missing": "Complete client timing is unavailable",
    'vertex_paygo.tauri.request_blocked': 'Native request failed: {message}',
    'vertex_paygo.tauri.title': `${EXTENSION_DISPLAY_NAME} · TauriTavern`,
    'vertex_paygo.tauri.native': "Requests use TauriTavern native authentication and transport. No companion server plugin is needed.",
    'vertex_paygo.tauri.scope': "Configure:",
    'vertex_paygo.tauri.current': "Current Chat Completion connection",
    'vertex_paygo.tauri.refresh': "Refresh connections",
    'vertex_paygo.tauri.controls_missing': "TauriTavern extension settings were not found.",
    'vertex_paygo.tauri.target_missing': "The selected Model Target no longer exists. Refresh the connection list.",
    'vertex_paygo.tauri.select_google': "Select a Google Vertex AI or Google AI Studio connection to configure its service tier.",
    'vertex_paygo.tauri.applied': "Native request tier: {tier}. Flex failures are not retried as Standard by this extension.",
    'vertex_paygo.tauri.cost_notice': "Non-streaming cost estimates may be inaccurate or too low because TauriTavern can omit thinking-token and other usage details.",
    'vertex_paygo.tauri.cost_coverage': "TauriTavern: this ledger records ordinary chat and requests passing through compatible frontend send interfaces. Native Agent/sub-Agent model loops are not included. Non-streaming usage can omit thinking tokens and other details, so estimates may be inaccurate or too low.",
    'vertex_paygo.tauri.cancel': "Cancel",
    'vertex_paygo.tauri.settings_changed': "The connection changed while confirming. Review the current connection and select the tier again.",
    'vertex_paygo.tauri.yaml_missing': "The host YAML library is unavailable. Native parameters could not be configured.",
    'vertex_paygo.tauritavern.title': 'TauriTavern compatibility APIs are unavailable',
    'vertex_paygo.tauritavern.unavailable': `This build does not expose the native parameter or extension storage APIs required by ${EXTENSION_DISPLAY_NAME}. Update to a compatible TauriTavern build (tested with 2.3.0) and check that third-party extensions are allowed. Manual parameter instructions are provided below.`,
    'vertex_paygo.tauritavern.vertex_title': 'Google Vertex AI: Standard / Flex / Priority',
    'vertex_paygo.tauritavern.vertex_steps': 'In TauriTavern 2.1.0 or later, open API Connections → Chat Completion → Google Vertex AI. Select a supported Gemini model and set Region to global for Flex or Priority. Click Additional Parameters beside Connect, then enter this YAML in Include Request Headers for Flex:',
    'vertex_paygo.tauritavern.vertex_flex': 'X-Vertex-AI-LLM-Request-Type: shared\nX-Vertex-AI-LLM-Shared-Request-Type: flex',
    'vertex_paygo.tauritavern.ai_studio_title': 'Google AI Studio: Standard / Flex',
    'vertex_paygo.tauritavern.ai_studio_steps': 'Select Google AI Studio first, using a paid Gemini API account and a model that supports Flex. Open Additional Parameters → Include Body Parameters and add this YAML (no Vertex headers needed):',
    'vertex_paygo.tauritavern.ai_studio_flex': 'service_tier: flex',
    'vertex_paygo.tauritavern.ai_studio_standard': 'To return to Standard, remove the service_tier field. Google AI Studio does not need a Vertex region setting.',
    'vertex_paygo.tauritavern.finish': 'Parameters are saved automatically for each API source; close the dialog when done. Preserve unrelated parameters. If these fields are missing, update TauriTavern to 2.1.0 or later. You can disable or uninstall this extension in Extensions.',
    'vertex_paygo.tauritavern.close': 'Got it',
    'vertex_paygo.costs.recording_unavailable': 'This request could not be added to the usage ledger. Conversation costs will be incomplete.',
    'vertex_paygo.server_error.csrf': 'SillyTavern rejected the CSRF token (HTTP 403). Refresh the page and try again.',
    'vertex_paygo.server_error.http_non_json': 'Server Plugin request failed (HTTP {status}); the server or reverse proxy returned no JSON error details.',
    'vertex_paygo.title': `${EXTENSION_DISPLAY_NAME} · Vertex AI`,
    'vertex_paygo.ai_studio.title': `${EXTENSION_DISPLAY_NAME} · AI Studio`,
    'vertex_paygo.ai_studio.guidance': 'Flex uses discounted token pricing and may take longer. A paid Gemini API account is required. Failed Flex requests will not automatically switch to Standard.',
    'vertex_paygo.ai_studio.status': '{tier} will use Google AI Studio; no Vertex region setting is required.',
    'vertex_paygo.ai_studio.tiers': 'This extension supports Standard and Flex for Google AI Studio.',
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
    'vertex_paygo.status.model_unresolved': 'Waiting for SillyTavern to load the Google model.',
    'vertex_paygo.status.non_gemini': 'PayGo routing is excluded for non-Gemini models.',
    'vertex_paygo.status.blocked': 'Blocked: {message}',
    'vertex_paygo.status.tier_global': '{tier} PayGo will use the global endpoint.',
    'vertex_paygo.error.persist': 'Could not persist the PayGo setting: {error}',
    'vertex_paygo.error.controls_missing': 'SillyTavern Vertex AI controls were not found.',
    'vertex_paygo.error.controls_timeout': 'Timed out waiting for SillyTavern Vertex AI controls.',
    'vertex_paygo.error.context_unavailable': 'SillyTavern public extension context is unavailable.',
    'vertex_paygo.error.paygo_only_gemini': 'PayGo-only routing is available only for Gemini models.',
    'vertex_paygo.policy.gemini_only': 'PayGo tier controls are available only for native Gemini model IDs (gemini-*).',
    'vertex_paygo.policy.native_standard': 'Standard Gemini requests use the Server Plugin to collect usage without changing their service tier.',
    'vertex_paygo.policy.known': 'Supported for {tier} PayGo as of {date}.',
    'vertex_paygo.policy.unsupported': 'This model is in the {date} PayGo snapshot, but not in the {tier} list.',
    'vertex_paygo.policy.unverified': 'This Gemini model is not in the {date} snapshot; Google will perform the final validation.',
    'vertex_paygo.validation.non_gemini': 'PayGo routing was requested for a non-Gemini model.',
    'vertex_paygo.validation.global_required': '{tier} PayGo requires the global Vertex AI endpoint.',
    'vertex_paygo.popup.tier_region.title': '{tier} PayGo requires global',
    'vertex_paygo.popup.tier_region.body': 'The current Vertex AI region is “{region}”. Choose whether to switch both the service tier and region, or keep the current region with Standard.',
    'vertex_paygo.popup.tier_region.accept': 'Use {tier} and global',
    'vertex_paygo.popup.tier_region.decline': 'Keep region and Standard',
    'vertex_paygo.popup.region.title': 'Regional endpoints use Standard',
    'vertex_paygo.popup.region.body': '{tier} PayGo currently requires global. Keep the new region with Standard, or keep global with the current tier.',
    'vertex_paygo.popup.region.accept': 'Use new region and Standard',
    'vertex_paygo.popup.region.decline': 'Keep global and {tier}',
    'vertex_paygo.popup.model.reason_gemini': 'PayGo routing is restricted to Gemini models.',
    'vertex_paygo.popup.model.reason_unsupported': 'The selected model does not support this PayGo tier.',
    'vertex_paygo.popup.model.title': 'Model and PayGo tier conflict',
    'vertex_paygo.popup.model.body': '{reason} Use the new model with Standard, or restore the previous model and keep the PayGo setting.',
    'vertex_paygo.popup.model.accept': 'Use new model and Standard',
    'vertex_paygo.popup.model.decline': 'Restore previous model',
    'vertex_paygo.popup.saved.title': 'Saved PayGo setting is incompatible',
    'vertex_paygo.popup.saved.body': '{message} Switch this connection to Standard, or keep the saved setting blocked until you change the model.',
    'vertex_paygo.popup.saved.accept': 'Use Standard',
    'vertex_paygo.popup.saved.decline': 'Keep blocked setting',
    'vertex_paygo.hook.proxy_conflict': `${EXTENSION_DISPLAY_NAME} is incompatible with a custom reverse proxy. Disable the reverse proxy before generating.`,
    'vertex_paygo.hook.request_blocked': '{message} The request was blocked and was not sent to Google.',
    'vertex_paygo.server_error.invalid_proxy_url': 'Server Plugin returned an invalid proxy URL.',
    'vertex_paygo.server_error.unsafe_proxy_url': 'Server Plugin proxy URL is not an authenticated loopback HTTP endpoint.',
    'vertex_paygo.server_error.invalid_response': 'Server Plugin returned a non-JSON response.',
    'vertex_paygo.server_error.invalid_log_response': 'Server Plugin returned an invalid log response.',
    'vertex_paygo.server_error.log_too_large': 'Server Plugin log exceeds the {size} limit.',
    'vertex_paygo.server_error.http': 'Server Plugin request failed: {message}',
    'vertex_paygo.server_error.timeout': 'Server Plugin request timed out.',
    'vertex_paygo.server_error.unavailable': 'Server Plugin is unavailable.',
    'vertex_paygo.server_error.protocol': 'Server Plugin protocol v{version} is required.',
    'vertex_paygo.server_error.transport': 'Server Plugin transport “{transport}” is required.',
    'vertex_paygo.server_error.ticket': 'Server Plugin ticket does not match its proxy URL.',
    'vertex_paygo.server_error.secret': 'Server Plugin returned an invalid proxy secret.',
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

export function localizeError(
    localize,
    error,
    { protocolVersion = PROTOCOL_VERSION, transport = REQUIRED_TRANSPORT } = {},
) {
    const keyByCode = {
        PAYGO_ONLY_REMOVED: 'vertex_paygo.server_error.paygo_only_removed',
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
    };

    if (error?.code === 'HTTP_ERROR') {
        if (error.responseFormat === 'non-json') return localize('vertex_paygo.server_error.http_non_json', { status: error.status });
        const details = [error.status ? `HTTP ${error.status}` : '', error.serverCode].filter(Boolean).join(' / ');
        return localize('vertex_paygo.server_error.http', {
            message: `${error instanceof Error ? error.message : String(error)}${details ? ` (${details})` : ''}`,
        });
    }

    const key = keyByCode[error?.code];
    if (key) {
        return localize(key, { version: protocolVersion, transport, size: '5 MiB' });
    }
    return error instanceof Error ? error.message : String(error);
}
