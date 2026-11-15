package com.example.sbex.core.messaging;

import com.example.sbex.core.AppProperties;
import tools.jackson.databind.json.JsonMapper;
import org.springframework.amqp.core.Binding;
import org.springframework.amqp.core.BindingBuilder;
import org.springframework.amqp.core.DirectExchange;
import org.springframework.amqp.core.Queue;
import org.springframework.amqp.core.QueueBuilder;
import org.springframework.amqp.core.TopicExchange;
import org.springframework.amqp.support.converter.JacksonJsonMessageConverter;
import org.springframework.amqp.support.converter.MessageConverter;
import org.springframework.aot.hint.annotation.RegisterReflectionForBinding;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

/**
 * Topology and payload conversion, declared in code: the exchange, queues and
 * bindings are versioned next to the consumers that need them, and a broker
 * wiped and redeclared from this application comes back identical
 * (sbex/messaging.md).
 */
@Configuration(proxyBeanMethods = false)
// A native image cannot see Jackson reflecting on the payload record — the
// serializer is reachable, the record's accessors are not. The binding hint is
// what makes the SAME publisher work under -Pnative and on the JVM.
@RegisterReflectionForBinding(OrderPlaced.class)
public class RabbitTopologyConfig {

	/** Queue the servlet application consumes; the annotation needs a constant. */
	public static final String ORDERS_QUEUE = "sbex.orders.events";

	private static final String DEAD_LETTER_EXCHANGE = "sbex.orders.dlx";
	private static final String ORDERS_ROUTING_KEY = "order.placed";

	/**
	 * JacksonJsonMessageConverter, not Jackson2JsonMessageConverter: the latter
	 * speaks the Jackson 2 ObjectMapper that Boot 4 no longer auto-configures,
	 * and is deprecated for removal in Spring AMQP 4.1. The JsonMapper bean is
	 * Boot's (spring-boot-jackson), so the payload contract and the framework's
	 * own JSON share one configuration.
	 */
	@Bean
	MessageConverter payloadConverter(JsonMapper jsonMapper) {
		return new JacksonJsonMessageConverter(jsonMapper);
	}

	@Bean
	TopicExchange ordersExchange(AppProperties properties) {
		return new TopicExchange(properties.eventsExchange(), true, false);
	}

	@Bean
	Queue ordersQueue() {
		// Quorum: disk-backed and replicated, the durability choice for
		// messages whose loss costs money. Dead-lettering gives a poison
		// message somewhere to land instead of looping forever.
		return QueueBuilder.durable(ORDERS_QUEUE)
			.withArgument("x-queue-type", "quorum")
			.withArgument("x-dead-letter-exchange", DEAD_LETTER_EXCHANGE)
			.withArgument("x-dead-letter-routing-key", ORDERS_QUEUE)
			.build();
	}

	@Bean
	Binding ordersBinding(TopicExchange ordersExchange, Queue ordersQueue) {
		return BindingBuilder.bind(ordersQueue).to(ordersExchange).with(ORDERS_ROUTING_KEY);
	}

	@Bean
	DirectExchange deadLetterExchange() {
		return new DirectExchange(DEAD_LETTER_EXCHANGE, true, false);
	}

	@Bean
	Queue deadLetterQueue() {
		return QueueBuilder.durable(ORDERS_QUEUE + ".dlq").build();
	}

	@Bean
	Binding deadLetterBinding(Queue deadLetterQueue, DirectExchange deadLetterExchange) {
		return BindingBuilder.bind(deadLetterQueue).to(deadLetterExchange).with(ORDERS_QUEUE);
	}
}
