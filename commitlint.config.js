export default {
  extends: ['@commitlint/config-conventional'],
  rules: {
    'scope-enum': [
      2,
      'always',
      [
        'shared',
        'dsl',
        'engine',
        'providers',
        'normalizer',
        'proof',
        'api',
        'web',
        'evaluation',
        'datasets',
        'docs',
        'ci',
        'deps',
        'repo',
      ],
    ],
  },
};
