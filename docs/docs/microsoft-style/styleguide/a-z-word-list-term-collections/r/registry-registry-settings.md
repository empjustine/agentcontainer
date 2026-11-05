---
title: registry, registry settings - Microsoft Style Guide
author: pallep
ms.author: pallep
ms.date: 08/16/2019
ms.topic: article
ms.prod: non-product-specific
---

# registry, registry settings

Use lowercase for the word _registry_ except when referring to a named system component, such as the Registry Editor.

Use
all uppercase letters for the first-level subtrees,
separating words with underscore characters. Registry subtrees are
usually bold.

**Examples**  
**HKEY\_CLASSES\_ROOT**  
**HKEY\_LOCAL\_MACHINE**

Keys
are developer defined and are usually all uppercase or a mix of
uppercase and lowercase characters, with no underscores. Subkeys are
usually a mix of uppercase and lowercase characters.

**Examples**  
**SOFTWARE**  
**ApplicationIdentifier**  
**CurrentVersion**

Refer to an entire subkey path as a _subkey,_ not a _path_.

**Example**  
(typical subkey ) **\\HKEY\_LOCAL\_MACHINE\\SOFTWARE\\Policies\\Microsoft\\SystemCertificates\\AuthRoot**

In a subkey, use _entries_ to describe the items in the **Name** column. Use _values_ to describe the items in the **Data** column.

**See also** [Formatting developer text elements](~/developer-content/formatting-developer-text-elements.md)
