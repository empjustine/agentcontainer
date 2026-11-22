package com.example.sbex.lakehouse;

import jakarta.servlet.http.HttpServletRequest;
import java.io.IOException;
import java.io.InputStream;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

/**
 * The request body readers. An empty body is an empty object, as the daemon
 * reads it, and a body that is not an object is a 400: a handler that then
 * reads a field from it would otherwise answer a 500 for a client mistake.
 */
final class Bodies {

	private Bodies() {
	}

	static JsonNode json(HttpServletRequest request, JsonMapper mapper) {
		try (InputStream body = request.getInputStream()) {
			JsonNode node = mapper.readTree(body);
			if (node == null || node.isNull()) {
				return mapper.createObjectNode();
			}
			if (!node.isObject()) {
				throw new LakehouseProblems.BadRequestException("body must be an object");
			}
			return node;
		} catch (IOException exception) {
			throw new LakehouseProblems.BadRequestException("request read failed", exception);
		} catch (RuntimeException malformed) {
			throw new LakehouseProblems.BadRequestException("invalid json: " + malformed.getMessage(), malformed);
		}
	}
}
