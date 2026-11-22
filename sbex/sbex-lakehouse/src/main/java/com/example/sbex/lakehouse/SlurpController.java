package com.example.sbex.lakehouse;

import jakarta.servlet.http.HttpServletRequest;
import java.io.IOException;
import java.util.LinkedHashMap;
import java.util.Map;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * The producer's ingest edge (docs/d204). One envelope, one transaction, one
 * ack; the ack counts are what the producer's backoff reads.
 */
@RestController
class SlurpController {

	private final SlurpIngest ingest;

	SlurpController(SlurpIngest ingest) {
		this.ingest = ingest;
	}

	@PostMapping("/ingest/slurp")
	Map<String, Object> slurp(HttpServletRequest request) throws IOException {
		SlurpIngest.Ack ack = ingest.ingest(request.getInputStream());
		Map<String, Object> body = new LinkedHashMap<>();
		body.put("accepted", ack.accepted());
		body.put("duplicates", ack.duplicates());
		body.put("version", Daemon.VERSION);
		body.put("checkpoint", ack.checkpoint());
		return body;
	}
}
