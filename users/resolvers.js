import { AuthenticationError, UserInputError } from 'apollo-server';
import jwt from 'jsonwebtoken';

const resolvers = {
  Query: {
    async me(_parent, _args, context, _info) {
      const { User } = context.models;

      if (!context.user) {
        return null;
      }

      const user = await User.findOne({ _id: context.user.id });
      if (!user) {
        throw new AuthenticationError('You must be logged in.');
      }

      return {
        id: user._id.toString(),
        displayName: user.displayName,
        firstName: user.firstName,
        lastName: user.lastName,
        roles: user.roles
      };
    },
  },
  Mutation: {
    async signIn(_parent, args, context, _info) {
      const { User } = context.models;

      if (!args.email || !args.password) {
        throw new UserInputError('MISSING_FIELDS');
      }

      const user = await User.findOne({ email: args.email }, '_id password roles salt');
      if (user && user.authenticate(args.password)) {
        return {
          token: jwt.sign({ id: user._id, roles: user.roles }, context.env.JWT_SECRET)
        };
      }

      throw new UserInputError('INVALID_CREDENTIALS');
    },
    signOut(_parent, _args, _context, _info) {
      return true;
    },
    async signUp(_parent, args, context, _info) {
      const { User } = context.models;

      if (!args.firstName || !args.lastName || !args.email || !args.password) {
        throw new UserInputError('MISSING_FIELDS');
      }

      const user = new User(args);
      user.displayName = user.firstName + ' ' + user.lastName;
      user.provider = 'local';

      user.updateEmail(args.email);

      try {
        await user.save();
        return true;
      } catch (err) {
        switch (err.name) {
          case 'MongoServerError': {
            switch (err.code) {
              case 11000: {
                throw new UserInputError('EXISTING_EMAIL_ADDRESS');
              }
            }
          }

          case 'ValidationError': {
            if (err.errors.email) {
              throw new UserInputError('INVALID_EMAIL_ADDRESS');
            }
          }
        }
        return false;
      }
    }
  }
};

export default resolvers;
