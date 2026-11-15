package com.example.sbex.servlet;

import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.scheduling.concurrent.ThreadPoolTaskExecutor;
import org.springframework.web.servlet.config.annotation.AsyncSupportConfigurer;
import org.springframework.web.servlet.config.annotation.WebMvcConfigurer;

/**
 * The executor behind Spring MVC's async requests — the one
 * StreamingResponseBody runs on. Left unconfigured, MVC falls back to an
 * unbounded thread-per-request executor: a burst of streaming reports would
 * then grow the thread count without limit on a container that has none to
 * spare (sbex/memory.md).
 */
@Configuration
public class WebConfig implements WebMvcConfigurer {

	@Bean
	ThreadPoolTaskExecutor mvcAsyncExecutor() {
		ThreadPoolTaskExecutor executor = new ThreadPoolTaskExecutor();
		executor.setCorePoolSize(2);
		executor.setMaxPoolSize(8);
		executor.setQueueCapacity(64);
		executor.setThreadNamePrefix("mvc-async-");
		return executor;
	}

	@Override
	public void configureAsyncSupport(AsyncSupportConfigurer configurer) {
		// The bean call resolves through the configuration proxy (the default
		// proxyBeanMethods), so the dispatcher receives this same singleton —
		// proxyBeanMethods=false would construct a second executor here that
		// nothing manages.
		configurer.setTaskExecutor(mvcAsyncExecutor());
	}
}
