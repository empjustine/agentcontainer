package com.example.sbex.reactive;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.util.List;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.slf4j.MDC;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.WebApplicationType;
import org.springframework.context.annotation.Configuration;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

/**
 * The logging contract, proved rather than documented (sbex/non-functional-testing.md):
 * under the json profile every event is ONE physical line that parses as a JSON
 * object, the message's newlines and the throwable stay inside string fields,
 * and the MDC rides as top-level keys.
 *
 * WHY a child JVM: Logback is JVM-global, and a test JVM that initialized the
 * human pattern for an earlier test class would ignore this class's profile.
 * The child boots Spring with the shipped logback-spring.xml and the json
 * profile, so the assertion is about the real configuration in every run order.
 */
class StructuredLoggingTest {

	private static final JsonMapper JSON = JsonMapper.builder().build();

	@Test
	void oneJsonObjectPerEventEvenWithNewlinesAndAnException() throws IOException, InterruptedException {
		String marker = "structured-log-" + UUID.randomUUID();
		String java = Path.of(System.getProperty("java.home"), "bin", "java").toString();
		Process process = new ProcessBuilder(
				java,
				"-cp",
				System.getProperty("java.class.path"),
				Child.class.getName(),
				marker)
			.redirectErrorStream(true)
			.start();
		String output = new String(process.getInputStream().readAllBytes(), StandardCharsets.UTF_8);
		assertEquals(0, process.waitFor(), "the child booted with the json profile:\n" + output);

		List<String> lines = output.lines()
			.filter(line -> line.contains(marker))
			.toList();
		assertEquals(2, lines.size(), "one physical line per log event");

		JsonNode info = JSON.readTree(lines.get(0));
		assertEquals("INFO", info.path("level").asString(), "level is a field");
		assertEquals("sbex.structured-logging-test", info.path("logger_name").asString(), "logger name is a field");
		assertTrue(
			info.path("message").asString().contains("second line " + marker),
			"the newline stayed inside the message");
		assertEquals(
			"4bf92f3577b34da6a3ce929d0e0e4736",
			info.path("traceId").asString(),
			"MDC rides as a top-level field");
		assertEquals("sha256:test", info.path("subjectHash").asString(), "every MDC key is present");

		JsonNode warn = JSON.readTree(lines.get(1));
		assertEquals("WARN", warn.path("level").asString(), "the second event is the warn");
		assertTrue(
			warn.path("stack_trace").asString().contains("IllegalStateException"),
			"the throwable is a string field");
		assertFalse(
			output.lines().anyMatch(line -> line.startsWith("\tat ")),
			"no raw stack-trace line reaches stdout");
	}

	/** A context with no auto-configuration: only Boot's logging initialization runs. */
	@Configuration(proxyBeanMethods = false)
	static class ChildConfig {}

	/**
	 * The child entry. It boots (logging reads the json profile from the
	 * argument) and emits the two events the parent parses.
	 */
	public static final class Child {

		private Child() {}

		public static void main(String[] args) {
			SpringApplication application = new SpringApplication(ChildConfig.class);
			application.setWebApplicationType(WebApplicationType.NONE);
			// No context handle: a non-web child has only daemon threads, so it
			// exits when main returns, and the log lines are all this run exists for.
			application.run("--spring.profiles.active=json");
			String marker = args[0];
			MDC.put("traceId", "4bf92f3577b34da6a3ce929d0e0e4736");
			MDC.put("subjectHash", "sha256:test");
			try {
				Logger log = LoggerFactory.getLogger("sbex.structured-logging-test");
				log.info("first line {}\nsecond line {}", marker, marker);
				log.warn("event with failure {}", marker, new IllegalStateException("boom"));
			} finally {
				MDC.clear();
			}
		}
	}
}

