import { print } from 'graphql/language';

import {
  ApolloServerPlugin,
  GraphQLRequestListener,
  GraphQLRequestContext,
  GraphQLResponse,
} from 'apollo-server-plugin-base';
import { KeyValueCache, PrefixingKeyValueCache } from 'apollo-server-caching';
import { WithRequired, ValueOrPromise } from 'apollo-server-env';

// XXX This should use createSHA from apollo-server-core in order to work on
// non-Node environments. I'm not sure where that should end up ---
// apollo-server-sha as its own tiny module? apollo-server-env seems bad because
// that would add sha.js to unnecessary places, I think?
import { createHash } from 'crypto';

interface Options<TContext = Record<string, any>> {
  // Underlying cache used to save results. All writes will be under keys that
  // start with 'fqc:' and are followed by a fixed-size cryptographic hash of a
  // JSON object with keys representing the query document, operation name,
  // variables, and other keys derived from the sessionId and extraCacheKeyData
  // hooks. If not provided, use the cache in the GraphQLRequestContext instead
  // (ie, the cache passed to the ApolloServer constructor).
  cache?: KeyValueCache;

  // Define this hook if you're setting any cache hints with scope PRIVATE.
  // This should return a session ID if the user is "logged in", or null if
  // there is no "logged in" user.
  //
  // If a cachable response has any PRIVATE nodes, then:
  // - If this hook is not defined, a warning will be logged.
  // - Else if this hook returns null, it will not be cached.
  // - Else it will be cached under a cache key tagged with the session ID and
  //   mode "private".
  //
  // If a cachable response has no PRIVATE nodes, then:
  // - If this hook is not defined or returns null, it will be cached under a cache
  //   key tagged with the mode "no session".
  // - Else it will be cached under a cache key tagged with the mode
  //   "authenticated public".
  //
  // When reading from the cache:
  // - If this hook is not defined or returns null, look in the cache under a cache
  //   key tagged with the mode "no session".
  // - Else look in the cache under a cache key tagged with the session ID and the
  //   mode "private". If no response is found in the cache, then look under a cache
  //   key tagged with the mode "authenticated public".
  //
  // This allows the cache to provide different "public" results to anonymous
  // users and logged in users ("no session" vs "authenticated public").
  //
  // A common implementation of this hook would be to look in
  // requestContext.request.http.headers for a specific authentication header or
  // cookie.
  //
  // This hook may return a promise because, for example, you might need to
  // validate a cookie against an external service.
  sessionId?(
    requestContext: GraphQLRequestContext<TContext>,
  ): ValueOrPromise<string | null>;

  // Define this hook if you want the cache key to vary based on some aspect of
  // the request other than the query document, operation name, variables, and
  // session ID. For example, responses that include translatable text may want
  // to return a string derived from
  // requestContext.request.http.headers.get('Accept-Language'). The data may
  // be anything that can be JSON-stringified.
  extraCacheKeyData?(
    requestContext: GraphQLRequestContext<TContext>,
  ): ValueOrPromise<any>;
}

enum SessionMode {
  NoSession,
  Private,
  AuthenticatedPublic,
}

function sha(s: string) {
  return createHash('sha256')
    .update(s)
    .digest('hex');
}

function cacheKey(baseCacheKey: any, sessionMode: SessionMode) {
  return sha(JSON.stringify({ ...baseCacheKey, sessionMode }));
}

export default function plugin(
  options: Options = Object.create(null),
): ApolloServerPlugin {
  return {
    requestDidStart(
      outerRequestContext: GraphQLRequestContext<any>,
    ): GraphQLRequestListener<any> {
      const cache = new PrefixingKeyValueCache(
        options.cache || outerRequestContext.cache!,
        'fqc:',
      );

      let invokedHooks = false;
      let sessionId: string | null = null;
      let extraCacheKeyData: any = null;

      async function cacheGet(
        baseCacheKey: any,
        sessionMode: SessionMode,
      ): Promise<GraphQLResponse | null> {
        const key = cacheKey(baseCacheKey, sessionMode);
        const value = await cache.get(key);
        if (value === undefined) {
          return null;
        }
        return JSON.parse(value);
      }

      return {
        async execute(
          requestContext: WithRequired<
            GraphQLRequestContext<any>,
            'document' | 'operationName' | 'operation'
          >,
        ): Promise<GraphQLResponse | null> {
          // Call hooks. Save values which will be used in XXX as well.
          if (options.sessionId) {
            sessionId = await options.sessionId(requestContext);
          }
          if (options.extraCacheKeyData) {
            extraCacheKeyData = await options.extraCacheKeyData(requestContext);
          }
          invokedHooks = true;

          const baseCacheKey = {
            // XXX could also have requestPipeline add the unparsed document to requestContext;
            // can't just use requestContext.request.query because that won't be set for APQs
            document: print(requestContext.document),
            operationName: requestContext.operationName,
            variables: requestContext.request.variables,
            // XXX look at extensions?
            extra: extraCacheKeyData,
          };

          if (sessionId === null) {
            return cacheGet(baseCacheKey, SessionMode.NoSession);
          } else {
            const privateResponse = await cacheGet(
              { ...baseCacheKey, sessionId },
              SessionMode.Private,
            );
            if (privateResponse !== null) {
              return privateResponse;
            }
            return cacheGet(baseCacheKey, SessionMode.AuthenticatedPublic);
          }
        },

        async willSendResponse(
          requestContext: WithRequired<GraphQLRequestContext<any>, 'response'>,
        ) {
          const { response } = requestContext;
          if (response.errors || !response.data) {
            // This plugin never caches errors.
            return;
          }

          // We're pretty sure that any path that calls willSendResponse with a
          // non-error response will have already called our execute hook above,
          // but let's just double-check that, since accidentally ignoring
          // sessionId could be a big security hole.
          if (!invokedHooks) {
            throw new Error(
              'willSendResponse called without error, but execute not called?',
            );
          }

          // XXX look at actual cache flags
        },
      };
    },
  };
}

// XXX care about extension or about HTTP headers?
