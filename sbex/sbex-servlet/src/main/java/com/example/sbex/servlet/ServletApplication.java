package com.example.sbex.servlet;

import com.example.sbex.core.AppProperties;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.boot.context.properties.EnableConfigurationProperties;

/**
 * The blocking application (Tomcat, JdbcTemplate on the request thread).
 * scanBasePackages names the shared module explicitly: the application class
 * sits in its own package on purpose, so the scan states where the rest of
 * the code is instead of inheriting an accidental root package.
 */
@SpringBootApplication(scanBasePackages = "com.example.sbex")
@EnableConfigurationProperties(AppProperties.class)
public class ServletApplication {

	public static void main(String[] args) {
		SpringApplication.run(ServletApplication.class, args);
	}
}
