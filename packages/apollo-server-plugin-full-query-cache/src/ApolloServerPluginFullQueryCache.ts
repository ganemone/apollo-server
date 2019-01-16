// import * as assert from 'assert';
import {
  ApolloServerPlugin,
  GraphQLRequestListener,
} from 'apollo-server-plugin-base';
// import { ApolloError } from 'apollo-server-errors';
import { KeyValueCache } from 'apollo-server-caching';

interface Options {}

export default function plugin(options: Options = Object.create(null)) {
  let cache: KeyValueCache;

  return (): ApolloServerPlugin => ({
    requestDidStart(): GraphQLRequestListener<any> {
      return {
        async didResolveOperation({ request: { query }, queryHash }) {},
      };
    },
  });
}
