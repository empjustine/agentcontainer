package com.example.sbex.core.db;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

/** Beans the shared persistence layer needs that no starter provides. */
@Configuration(proxyBeanMethods = false)
public class PersistenceConfig {

	@Bean
	SqlDialect sqlDialect(@Value("${spring.datasource.url}") String jdbcUrl) {
		return SqlDialect.fromJdbcUrl(jdbcUrl);
	}
}
