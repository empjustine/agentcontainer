package com.example.sbex.lakehouse;

import jakarta.servlet.http.HttpServletRequest;
import java.io.IOException;
import java.util.LinkedHashMap;
import java.util.Map;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * The write-only session route of docs/d181: no read-back, no delete, no
 * update. A compromised sandbox can add rows and can never remove or rewrite
 * one, which is the diode property — so this controller has one mapping and no
 * other verb.
 */
@RestController
class AgentIngestController {

	private static final Logger log = LoggerFactory.getLogger(AgentIngestController.class);

	private final SessionIngest ingest;

	AgentIngestController(SessionIngest ingest) {
		this.ingest = ingest;
	}

	@PostMapping("/ingest/session")
	Map<String, Object> session(HttpServletRequest request) throws IOException {
		SessionIngest.Ack ack = ingest.ingest(request.getInputStream());
		log.info("accepted={} duplicates={}", ack.accepted(), ack.duplicates());
		Map<String, Object> body = new LinkedHashMap<>();
		body.put("accepted", ack.accepted());
		body.put("duplicates", ack.duplicates());
		return body;
	}
}
