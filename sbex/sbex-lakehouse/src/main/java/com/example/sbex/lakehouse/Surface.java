package com.example.sbex.lakehouse;

/**
 * Which protocol a listener answers. A request carries its surface as a
 * request attribute because the two protocols share one path (/search) and
 * differ in the answer, not in the route.
 */
public enum Surface {
	HISTER,
	PROMNESIA,
	AGENT,
}
