import plugin from '../ApolloServerPluginFullQueryCache';

describe.only('Full query cache plugin', () => {
  it('will instantiate when not called with options', () => {
    expect(plugin()()).toHaveProperty('requestDidStart');
  });
});
