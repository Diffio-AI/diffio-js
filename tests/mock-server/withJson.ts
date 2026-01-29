import { passthrough, type HttpResponseResolver } from "msw";

import { fromJson, toJson } from "./json";

export function withJson(expectedBody: unknown, resolver: HttpResponseResolver): HttpResponseResolver {
  return async (args) => {
    const { request } = args;

    let clonedRequest: Request;
    let bodyText: string | undefined;
    let actualBody: unknown;
    try {
      clonedRequest = request.clone();
      bodyText = await clonedRequest.text();
      if (bodyText === "") {
        console.error("Request body is empty, expected a JSON object");
        return passthrough();
      }
      actualBody = fromJson(bodyText);
    } catch (error) {
      console.error(`Error processing request body:\n\tError: ${error}\n\tBody: ${bodyText}`);
      return passthrough();
    }

    const mismatches = findMismatches(actualBody, expectedBody);
    if (Object.keys(mismatches).length > 0) {
      console.error("JSON body mismatch:", toJson(mismatches, undefined, 2));
      return passthrough();
    }

    return resolver(args);
  };
}

function findMismatches(actual: any, expected: any): Record<string, { actual: any; expected: any }> {
  const mismatches: Record<string, { actual: any; expected: any }> = {};

  if (typeof actual !== typeof expected) {
    return { value: { actual, expected } };
  }

  if (typeof actual !== "object" || actual === null || expected === null) {
    if (actual !== expected) {
      return { value: { actual, expected } };
    }
    return {};
  }

  if (Array.isArray(actual) && Array.isArray(expected)) {
    if (actual.length !== expected.length) {
      return { length: { actual: actual.length, expected: expected.length } };
    }

    const arrayMismatches: Record<string, { actual: any; expected: any }> = {};
    for (let i = 0; i < actual.length; i++) {
      const itemMismatches = findMismatches(actual[i], expected[i]);
      if (Object.keys(itemMismatches).length > 0) {
        for (const [mismatchKey, mismatchValue] of Object.entries(itemMismatches)) {
          arrayMismatches[`[${i}]${mismatchKey === "value" ? "" : `.${mismatchKey}`}`] = mismatchValue;
        }
      }
    }
    return arrayMismatches;
  }

  const actualKeys = Object.keys(actual);
  const expectedKeys = Object.keys(expected);
  const allKeys = new Set([...actualKeys, ...expectedKeys]);

  for (const key of allKeys) {
    if (!expectedKeys.includes(key)) {
      if (actual[key] === undefined) {
        continue;
      }
      mismatches[key] = { actual: actual[key], expected: undefined };
    } else if (!actualKeys.includes(key)) {
      if (expected[key] === undefined) {
        continue;
      }
      mismatches[key] = { actual: undefined, expected: expected[key] };
    } else if (
      typeof actual[key] === "object" &&
      actual[key] !== null &&
      typeof expected[key] === "object" &&
      expected[key] !== null
    ) {
      const nestedMismatches = findMismatches(actual[key], expected[key]);
      if (Object.keys(nestedMismatches).length > 0) {
        for (const [nestedKey, nestedValue] of Object.entries(nestedMismatches)) {
          mismatches[`${key}${nestedKey === "value" ? "" : `.${nestedKey}`}`] = nestedValue;
        }
      }
    } else if (actual[key] !== expected[key]) {
      mismatches[key] = { actual: actual[key], expected: expected[key] };
    }
  }

  return mismatches;
}
