package com.example.sbex.reactive;

import com.example.sbex.core.AppProperties;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.boot.context.properties.EnableConfigurationProperties;

/**
 * The non-blocking application (Netty event loop, WebClient). Virtual threads
 * are deliberately NOT enabled here: they are the servlet stack's answer to
 * blocking, and the reactive stack answers the same problem by never blocking
 * the threads it has (sbex/servlet-vs-reactive.md).
 */
@SpringBootApplication(scanBasePackages = "com.example.sbex")
@EnableConfigurationProperties(AppProperties.class)
public class ReactiveApplication {

	public static void main(String[] args) {
		SpringApplication.run(ReactiveApplication.class, args);
	}
}
