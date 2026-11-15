package com.example.sbex.servlet;

import org.springframework.amqp.rabbit.config.SimpleRabbitListenerContainerFactory;
import org.springframework.amqp.rabbit.connection.ConnectionFactory;
import org.springframework.boot.amqp.autoconfigure.SimpleRabbitListenerContainerFactoryConfigurer;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.transaction.PlatformTransactionManager;

/**
 * The listener container runs each delivery inside the same transaction that
 * writes the database rows: the channel ack joins the commit, so a rollback
 * requeues the message instead of acknowledging work that never happened
 * (sbex/messaging.md, Spring AMQP's "Transaction Management").
 */
@Configuration(proxyBeanMethods = false)
public class ListenerConfig {

	/**
	 * The bean name is the contract: Boot's auto-configured factory backs off
	 * when one of this name exists, and the yml listener.simple.* settings
	 * still apply because the configurer is the one that reads them.
	 */
	@Bean
	SimpleRabbitListenerContainerFactory rabbitListenerContainerFactory(
		SimpleRabbitListenerContainerFactoryConfigurer configurer,
		ConnectionFactory connectionFactory,
		PlatformTransactionManager transactionManager) {
		SimpleRabbitListenerContainerFactory factory = new SimpleRabbitListenerContainerFactory();
		configurer.configure(factory, connectionFactory);
		factory.setTransactionManager(transactionManager);
		// channelTransacted is what folds the ack into the transaction. With it
		// off, an external transaction manager still wraps the listener but the
		// messaging operations auto-ack — a business rollback would commit the
		// acknowledgement anyway.
		factory.setChannelTransacted(true);
		return factory;
	}
}
