package com.example.sbex.lakehouse;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.boot.context.properties.EnableConfigurationProperties;

/**
 * The datalakehouse daemons as one application: Tomcat serves the hister
 * listener, the Promnesia listener and the write-only session route from one
 * process, and the port a request arrived on decides which protocol it may
 * speak (sbex/datalakehouse-port.md, Listener topology).
 *
 * WHY one process and not one application per surface: the two faces write the
 * same SQLite store, so a second JVM would be a second writer, a second pool
 * and a second heap for a local tool. The disjointness the two-application
 * shape gave for free is a test here (SurfaceFilter, LakehouseApiTest).
 */
@SpringBootApplication(scanBasePackages = "com.example.sbex.lakehouse")
@EnableConfigurationProperties(LakehouseProperties.class)
public class LakehouseApplication {

	public static void main(String[] args) {
		SpringApplication.run(LakehouseApplication.class, args);
	}
}
