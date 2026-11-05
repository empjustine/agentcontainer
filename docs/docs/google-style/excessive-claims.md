<!-- source: https://developers.google.com/style/excessive-claims -->
<!-- clipped: 2026-11-05 -->

# Avoid excessive claims

## Page Summary

- Avoid excessive claims in documentation, which are statements about performance, cost, or security that aren't easily verifiable or could be invalidated by future events.
- Refrain from using superlatives and subjective language when describing products and features, instead focusing on factual and objective information.
- When making specific performance or security claims, ensure they are backed by verifiable data and consider potential future scenarios that could impact their validity.
- Emphasize the intended benefits and design of features rather than making absolute guarantees, especially regarding security.
- Prioritize writing factually and objectively, providing verifiable information that will remain true throughout the documentation's lifespan, even when comparing products.

In documentation, don't make excessive claims. An _excessive claim_ is an assertion
in the documentation that does any of the following:

- Makes a statement about performance or cost that isn't easily verifiable with data
  that's available to the reader.
- Makes a statement about security that would be invalidated by a security incident.
- Makes a statement that might be interpreted as subjective or even disparaging,
  especially about third-party products.

When you're assessing whether some text makes an excessive claim, take into account
not just what's true today about a product's performance, cost, security, or
functionality, but what might be true in the future.

Consider the following guidelines:

- When you describe products, avoid superlatives like _best_, _simplest_,
  _fastest_, _never_, and _always_. Similarly, be
  careful about words like _ensure_ and _guarantee_ and use them only when
  something can truly be ensured or guaranteed.
- If you make specific performance claims—how fast a product is, how much storage
  it requires, and so on—make sure that you reference the source of your information.
- If documentation claims that a product is secure, the documentation
  is invalid (and not credible) if someone succeeds in compromising the product.
  It's safer to suggest that a feature "helps with security" or "is designed for
  security" because those statements are true even if a security incident occurs.
- A statement that you make about a competitive product might be untrue if you
  misinterpret how the product works, or later if the other company comes out with
  a new release.

The safest approach is always to write factually and objectively, limiting what you say to
verifiable information that will be true over the lifespan of your documentation.

Recommended: Our product
distributes datasets and computation in memory across a cluster, and
therefore it can be faster for this scenario than ExampleCorporation's product. For
more information, see [Performance comparison](https://www.google.com/).

Not recommended: Our product is
faster than ExampleCorp's product.

Recommended: Using our security product
is part of an overall strategy that helps prevent account takeovers from phishing attacks.

Not recommended: Our security product
prevents account takeovers from phishing attacks.
