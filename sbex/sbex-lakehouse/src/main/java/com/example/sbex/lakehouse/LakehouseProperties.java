package com.example.sbex.lakehouse;

import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import java.time.Duration;
import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.validation.annotation.Validated;

/**
 * The `lakehouse.*` surface as one validated record, so a mistyped ceiling fails
 * the boot with the property name instead of comparing false forever (a body
 * ceiling that compares false is no ceiling).
 *
 * @param histerAddress host:port of the hister listener, the port the stock
 *     extension already defaults to
 * @param promnesiaAddress host:port of the Promnesia listener
 * @param agentAddress host:port of the write-only session route
 * @param store the hot SQLite store; created 0600 in a 0700 directory
 * @param token the static key the hister write faces require; empty disables
 *     the gate, which a non-loopback bind then refuses
 * @param agentToken the session route's key, the whole boundary on a wide bind
 * @param maxBody bytes one request may carry, on every surface
 * @param maxFormFields fields one form body may carry
 * @param maxPdfBytes the decoded PDF ceiling
 * @param maxVisitedUrls URLs one visited check may carry
 * @param readerPoolSize connections the read faces may hold; the writer pool
 *     is one connection by construction
 * @param maxWorkers the request-thread ceiling of every connector; sqlite-jdbc
 *     blocks in a native call, so the bound is platform threads, not virtual
 *     ones
 * @param pdfTimeout wall clock one extraction may take
 * @param pdfMaxText bytes extracted text may weigh
 * @param pdfHeap the child JVM's heap cap
 * @param pdfRunner an operator prefix for the worker command, for a
 *     namespace/container wrapper
 * @param spool the session leg's append tail
 * @param ingestMaxBody bytes one session post may carry
 * @param ingestMaxRows rows one session post may carry
 * @param sender the shared shell sender; empty disables the self-fold
 * @param warehouseToken the MotherDuck token the sender needs; empty disables the
 *     self-fold
 * @param spoolMaxBytes the tail the daemon folds at; 0 disables the self-fold
 * @param spoolSendRetry how long a failed or busy fold waits before retrying
 */
@ConfigurationProperties(prefix = "lakehouse")
@Validated
public record LakehouseProperties(
	@NotBlank String histerAddress,
	@NotBlank String promnesiaAddress,
	@NotBlank String agentAddress,
	@NotBlank String store,
	String token,
	String agentToken,
	@Min(1) int maxBody,
	@Min(1) int maxFormFields,
	@Min(1) int maxPdfBytes,
	@Min(1) int maxVisitedUrls,
	@Min(1) int readerPoolSize,
	@Min(1) int maxWorkers,
	@NotNull Duration pdfTimeout,
	@Min(1) int pdfMaxText,
	@NotBlank String pdfHeap,
	String pdfRunner,
	@NotBlank String spool,
	@Min(1) int ingestMaxBody,
	@Min(1) int ingestMaxRows,
	String sender,
	String warehouseToken,
	@Min(0) int spoolMaxBytes,
	@NotNull Duration spoolSendRetry) {

	/** The key the hister write faces require, or empty for a loopback-only host. */
	public String browseToken() {
		return token == null ? "" : token;
	}

	/** The session route's key, or empty when the bind is loopback. */
	public String ingestToken() {
		return agentToken == null ? "" : agentToken;
	}

	/** The shared sender, or empty when the self-fold is off. */
	public String spoolSender() {
		return sender == null ? "" : sender;
	}

	/** The MotherDuck token, absent when the host folds by an operator run only. */
	public String warehouseToken() {
		return warehouseToken == null ? "" : warehouseToken;
	}

	/** The operator's worker prefix, split by the shell when it is used. */
	public String workerPrefix() {
		return pdfRunner == null ? "" : pdfRunner;
	}
}
