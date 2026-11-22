package com.example.sbex.lakehouse;

import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.scheduling.concurrent.ThreadPoolTaskExecutor;
import org.springframework.web.servlet.config.annotation.AsyncSupportConfigurer;
import org.springframework.web.servlet.config.annotation.WebMvcConfigurer;

/**
 * The executor behind Spring MVC's async requests — the one a streaming read
 * face runs on. Left unconfigured, MVC falls back to an unbounded
 * thread-per-request executor, so a burst of large visit exports would grow the
 * thread count without limit (sbex/memory.md).
 *
 * The pool is deliberately smaller than the request-thread bound: a streamed
 * export is one cursor per thread, and the reader pool is the scarcer resource.
 */
@Configuration
public class AsyncConfig implements WebMvcConfigurer {

	private final LakehouseProperties properties;

	AsyncConfig(LakehouseProperties properties) {
		this.properties = properties;
	}

	@Bean
	ThreadPoolTaskExecutor mvcAsyncExecutor() {
		ThreadPoolTaskExecutor executor = new ThreadPoolTaskExecutor();
		executor.setCorePoolSize(2);
		executor.setMaxPoolSize(Math.min(8, properties.maxWorkers()));
		executor.setQueueCapacity(properties.maxWorkers() * 4);
		executor.setThreadNamePrefix("mvc-async-");
		return executor;
	}

	@Override
	public void configureAsyncSupport(AsyncSupportConfigurer configurer) {
		// The bean call resolves through the configuration proxy (the default
		// proxyBeanMethods), so the dispatcher receives this same singleton.
		configurer.setTaskExecutor(mvcAsyncExecutor());
	}
}
