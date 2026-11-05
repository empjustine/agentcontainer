<!-- source: https://developers.google.com/style/product-names -->
<!-- clipped: 2026-11-05 -->

# Product names

## Page Summary

- Capitalize Google product names in title case, except when matching UI labels or if the official name starts with a lowercase letter.
- Feature names are generally lowercase, unless officially capitalized or matching a UI label; follow existing documentation for precedents.
- Use the full trademarked product name, avoiding abbreviations unless matching a UI label and ensuring clarity in its reference.
- Use "the" before tool and API names, but not before product names unless qualifying something else; use "service" to refer to multiple products to avoid ambiguity.
- Avoid using product or feature names as verbs, maintaining clear and grammatically correct language.

This page describes how to use product names.

## Capitalize product names

In general, Google product names are in _title case_, sometimes called
_init-capped_, which means that every word is capitalized except for
prepositions like _of_ or _on_ and articles like _a_ or
_the_. When you refer to a Google product, use title case except
when you're matching a UI label. For information about how to refer to UI
labels, see
[UI elements and interaction](/style/ui-elements).

When you write about any product, follow the official capitalization for the
names of brands, companies, software, products, services, features, and
terms defined by companies and open source communities.

- For example, if you're using Kubernetes-related terms, then follow
  the capitalization that's shown in the Kubernetes [Concepts
  documentation](https://kubernetes.io/docs/concepts/).

  Recommended in a Kubernetes
  context: A Job creates one or more Pods.

  Recommended: The Cloud Scheduler
  job publishes a message to a Pub/Sub topic at one-minute intervals.

- If an official name begins with a lowercase letter, then put it in
  lowercase even at the start of a sentence. But it's better to revise
  the sentence to avoid putting a lowercase word at the start, if
  possible.

  Recommended: You can use macOS to
  run the app.

  Not recommended: macOS can run the
  app.

### Feature names

A _feature_ is a distinctive attribute or capability of a product.
Features are usually described in terms of what they can do as part of a
product. In general, feature names are lowercase, although there are
exceptions.

When you write about a feature, don't capitalize it unless the name is
officially capitalized. If you're unsure, follow the precedent that's set
by other documents that describe the feature. As with products, match
the capitalization of a UI label if you're referring to one.

For more general information about capitalization, see
[Capitalization](/style/capitalization).

## Shorten Google product names

When referring to a Google product, sometimes you might want to abbreviate
the product name. For example, when you're referring to Google
Spreadsheets, it can be awkward to refer to it as Google Spreadsheets
every time; sometimes you might want to call it Spreadsheets.

Use the full trademarked product name. Don't abbreviate product names,
except in cases where you're matching a UI label. In such cases, make it
clear that you're referring to the Google product and not some other thing
with a similar name.

Also consider whether you need to refer to a product name throughout a
document, or if you can use a more general term. For example, if you've
established that you're talking about _Anthos Service Mesh_, you can
probably frame your discussion around the concept of _a service mesh_
throughout much of the document.

## Possessives of product names

For information about forming possessives with product names, see
[Product, feature, and company names](/style/possessives#product,-feature,-and-company-names).

## Articles before product names

Don't use _the_ before a product name unless you're using the name to
modify something else. _Do_ use _the_ before tool and API names.

Recommended: Using Cloud Datastore with Cloud Dataproc

Recommended: The Cloud Datastore options page

Recommended: The Google Cloud console

Recommended: The Transcoder API

Recommended: The `gcloud` CLI

Not recommended: Using the Cloud Datastore with Cloud
Dataproc

If you use a product name as a modifier with an indefinite article (_a_ or _an_), pay
close attention to which article precedes the product name.

Recommended: An Anthos Service Mesh environment

Recommended: A Service Mesh environment

For more information about using articles, see [Articles](/style/articles).

## Use "service" to refer to multiple products

It's OK to refer to Google products as services, such as _the Google Kubernetes Engine
service_ or _the Compute Engine service_. However, if the term _services_ leads to
ambiguity, use the product names.

## Don't use product names as verbs

Don't use product names or feature names as verbs.
