import Bugsnag from '@bugsnag/js'
import { UserInputError } from 'apollo-server'
import { DateTime } from 'luxon'

import {
  canEnroll,
  canUpdateGroup,
  isCoordinator,
  isTeacher,
} from '../lib/courses.js'
import { hasRole } from '../lib/users.js'

// Check if the registered user has the student role
// and add it to him/her if not.
async function updateStudentStatus(models, userId) {
  const { User } = models

  const user = await User.findOne({ _id: userId })
  if (!user.roles.includes('student')) {
    user.roles.push('student')
    await user.save()
  }
}

const resolvers = {
  RegistrationInvitation: {
    REQUESTED: 'requested',
    SENT: 'sent',
  },
  Registration: {
    // Retrieve the 'datetime' of this registration from the MongoDB 'date'.
    datetime(registration, _args, _context, _info) {
      return registration.invitation
        ? registration.invitationDate
        : registration.date
    },
    // Retrieve the 'id' of this registration from the MongoDB '_id'.
    id(registration, _args, _context, _info) {
      return registration._id.toString()
    },
  },
  Query: {
    // Retrieve all the registrations
    // that are available to the connected user.
    async registrations(_parent, args, { models, user }, _info) {
      const { Course, Registration } = models

      const filter = {}

      // Only 'admin' can access all the registrations
      // without specifying a course code.
      if (!args.courseCode && !hasRole(user, 'admin')) {
        throw new UserInputError(
          'The courseCode param is required for non-admin users.'
        )
      }

      if (args.confirmed) {
        filter.invitation = { $exists: false }
      }

      if (args.courseCode) {
        const course = await Course.findOne(
          { code: args.courseCode },
          'coordinator groups teachers'
        ).lean()

        if (
          !course ||
          !(isCoordinator(course, user) || isTeacher(course, user))
        ) {
          throw new UserInputError('COURSE_NOT_FOUND')
        }

        // Filter the registrations according to the provided course code.
        filter.course = course._id

        // If teaching groups are defined, a teacher can only access
        // to the learners from his/her teaching groups.
        if (!isCoordinator(course, user) && course.groups?.teaching?.length) {
          const groups = course.groups.teaching
            .map((g, i) => ({ ...g, i }))
            .filter((g) => g.supervisor.toString() === user.id)
            .map((g) => g.i)
          filter.$or = [
            { 'group.teaching': { $exists: false } },
            { 'group.teaching': { $in: groups } },
          ]
        }
      }

      return await Registration.find(filter).populate('user').lean()
    },
  },
  Mutation: {
    // Accept an invitation sent by a teacher for a given course, as a user.
    async acceptInvitation(_parent, args, { models, user }, _info) {
      const { Course, Registration } = models

      const registration = await Registration.findOne(
        { _id: args.id },
        'course date invitation user'
      )
      if (!registration || registration.invitation !== 'sent') {
        throw new UserInputError('REGISTRATION_NOT_FOUND')
      }

      const course = await Course.findOne(
        { _id: registration.course },
        'archived coordinator published schedule visibility'
      ).lean()
      if (!course) {
        throw new UserInputError('COURSE_NOT_FOUND')
      }

      // Only the invited user can accept the invitation
      // for a course with the 'published' status and 'private' visibility
      // and within the registration schedule, if any.
      const now = DateTime.now()
      if (
        user.id !== registration.user.toString() ||
        !course.published ||
        course.archived ||
        !(
          course.visibility === 'invite-only' || course.visibility === 'private'
        ) ||
        !canEnroll(course, now)
      ) {
        throw new UserInputError('INVITATION_ACCEPTANCE_FAILED')
      }

      // Accept the invitation.
      registration.date = now
      registration.invitation = undefined

      // Save the registration into the database.
      try {
        await updateStudentStatus(models, registration.user)
        return await registration.save()
      } catch (err) {
        Bugsnag.notify(err)
      }

      return null
    },
    // Accept an invitation request made by a user for a given course, as its coordinator.
    async acceptInvitationRequest(_parent, args, { models, user }, _info) {
      const { Course, Registration } = models

      const registration = await Registration.findOne(
        { _id: args.id },
        'course date invitation user'
      )
      if (!registration || registration.invitation !== 'requested') {
        throw new UserInputError('REGISTRATION_NOT_FOUND')
      }

      const course = await Course.findOne(
        { _id: registration.course },
        'archived coordinator published schedule visibility'
      ).lean()
      if (!course) {
        throw new UserInputError('COURSE_NOT_FOUND')
      }

      // Only the coordinator can accept an invitation request
      // for a course with the 'published' status and 'invite-only' visibility
      // and within the registration schedule, if any.
      const now = DateTime.now()
      if (
        !isCoordinator(course, user) ||
        !course.published ||
        course.archived ||
        course.visibility !== 'invite-only' ||
        !canEnroll(course, now)
      ) {
        throw new UserInputError('INVITATION_REQUEST_ACCEPTANCE_FAILED')
      }

      // Accept the invitation request.
      registration.date = now
      registration.invitation = undefined

      // Save the registration into the database.
      try {
        await updateStudentStatus(models, registration.user)
        return await registration.save()
      } catch (err) {
        Bugsnag.notify(err)
      }

      return null
    },
    // Register to a given course, as a user.
    async register(_parent, args, { models, user }, _info) {
      const { Course, Registration } = models

      const course = await Course.findOne(
        { code: args.courseCode },
        '_id archived coordinator published schedule teachers visibility'
      ).lean()
      if (!course) {
        throw new UserInputError('Course not found.')
      }

      // Can only directly register to
      // a published course with 'public' visibility
      // and if the connected user is not the coordinator or a teacher of the course
      // and within the registration schedule, if any.
      const now = DateTime.now()
      if (
        !course.published ||
        course.archived ||
        course.visibility !== 'public' ||
        isCoordinator(course, user) ||
        isTeacher(course, user) ||
        !canEnroll(course, now)
      ) {
        throw new UserInputError('REGISTRATION_FAILED')
      }

      // Check whether there is not already a registration.
      const isRegistered = await Registration.exists({
        course: course._id,
        user: user.id,
      })
      if (isRegistered) {
        throw new UserInputError('ALREADY_REGISTERED')
      }

      const registration = new Registration({
        course: course._id,
        date: now,
        user: user.id,
      })

      // Create a new registration for the user.
      try {
        return await registration.save()
      } catch (err) {
        Bugsnag.notify(err)
      }

      return null
    },
    // Remove the teaching or working group associated to this registration.
    async removeGroup(_parent, args, { models, user }, _info) {
      const { Course, Registration } = models

      const groupType = args.type.toLowerCase()

      // Retrieve the registration that must be a confirmed one
      // to allow a group change.
      const registration = await Registration.findOne(
        { _id: args.id },
        'course group invitation'
      )
      if (
        !registration ||
        registration.invitation ||
        !registration.group[groupType]
      ) {
        throw new UserInputError('REGISTRATION_NOT_FOUND')
      }

      // Retrieve the course associated to the registration.
      const course = await Course.findOne(
        { _id: registration.course },
        'coordinator groups schedule'
      ).lean()
      if (!course) {
        throw new UserInputError('COURSE_NOT_FOUND')
      }

      // Only the coordinator can update the group of a student
      // for a course for which groups have been defined.
      const now = DateTime.now()
      if (
        !isCoordinator(course, user) ||
        !course.groups ||
        !course.groups[groupType]?.length ||
        !canUpdateGroup(course, now)
      ) {
        throw new UserInputError('GROUP_REMOVAL_FAILED')
      }

      // Update the group assignment of the student.
      registration.group[groupType] = undefined
      if (!Object.keys(registration.group).length) {
        registration.group = undefined
      }

      // Save the registration into the database.
      try {
        return await registration.save()
      } catch (err) {
        Bugsnag.notify(err)
      }

      return null
    },
    // Make a request to be invited for a given course, as a user.
    async requestInvitation(_parent, args, { models, user }, _info) {
      const { Course, Registration } = models

      const course = await Course.findOne(
        { code: args.courseCode },
        '_id archived coordinator published schedule teachers visibility'
      ).lean()
      if (!course) {
        throw new UserInputError('Course not found.')
      }

      // Can only request an invitation for
      // a published course with 'invite-only' visibility
      // and if the connected user is not the coordinator or a teacher of the course
      // and within the registration schedule, if any.
      const now = DateTime.now()
      if (
        !course.published ||
        course.archived ||
        course.visibility !== 'invite-only' ||
        isCoordinator(course, user) ||
        isTeacher(course, user) ||
        !canEnroll(course, now)
      ) {
        throw new UserInputError('INVITATION_REQUEST_FAILED')
      }

      // Check whether there is not already a registration.
      const isRegistered = await Registration.exists({
        course: course._id,
        user: user.id,
      })
      if (isRegistered) {
        throw new UserInputError('ALREADY_REGISTERED')
      }

      // Create a new registration for the user,
      // representing the invitation request.
      const registration = new Registration({
        course: course._id,
        invitation: 'requested',
        invitationDate: now,
        user: user.id,
      })

      try {
        return await registration.save()
      } catch (err) {
        Bugsnag.notify(err)
      }

      return null
    },
    // Send an invitation to an existing user or just to an email address.
    async sendInvitation(_parent, args, { models, user }, _info) {
      const { Course, Registration, User } = models

      const course = await Course.findOne(
        { code: args.courseCode },
        'archived coordinator published schedule teachers visibility'
      ).lean()
      if (!course) {
        throw new UserInputError('Course not found.')
      }

      // Check whether the user already exists on the platform.
      const invitedUser = await User.findOne(
        { email: args.email },
        '_id displayName email roles username'
      )

      // Only the coordinator can send an invitation
      // for a published course with 'invite-only' or 'private' visibility
      // and, if the user to invite exists, not to the coordinator or a teacher of the course
      // and within the registration schedule, if any.
      const now = DateTime.now()
      if (
        !isCoordinator(course, user) ||
        !course.published ||
        course.archived ||
        (course.visibility !== 'invite-only' &&
          course.visibility !== 'private') ||
        isCoordinator(course, invitedUser) ||
        isTeacher(course, invitedUser) ||
        !canEnroll(course, now)
      ) {
        throw new UserInputError('INVITATION_SENDING_FAILED')
      }

      // Check whether there is not already a registration.
      if (invitedUser) {
        const isRegistered = await Registration.exists({
          course: course._id,
          user: invitedUser._id,
        })
        if (isRegistered) {
          throw new UserInputError('ALREADY_REGISTERED_OR_INVITED')
        }
      }

      // Create a new registration for the user,
      // representing the invitation that has been sent.
      const fields = {
        course: course._id,
        invitation: 'sent',
        invitationDate: now,
        user: invitedUser,
      }
      if (!invitedUser) {
        fields.email = args.email

        // TODO: send an email to inform that the user has been invited
        console.log('invitation email sent!')
      }
      const registration = new Registration(fields)

      try {
        return await registration.save()
      } catch (err) {
        Bugsnag.notify(err)
      }

      return null
    },
    // Update the teaching or working group associated to this registration.
    async updateGroup(_parent, args, { models, user }, _info) {
      const { Course, Registration } = models

      const groupType = args.type.toLowerCase()

      // Retrieve the registration that must be a confirmed one
      // to allow a group change.
      const registration = await Registration.findOne(
        { _id: args.id },
        'course group invitation'
      )
      if (!registration || registration.invitation) {
        throw new UserInputError('REGISTRATION_NOT_FOUND')
      }

      // Retrieve the course associated to the registration.
      const course = await Course.findOne(
        { _id: registration.course },
        'coordinator groups schedule'
      ).lean()
      if (!course) {
        throw new UserInputError('COURSE_NOT_FOUND')
      }

      // Only the coordinator can update the group of a student
      // for a course for which groups have been defined.
      const now = DateTime.now()
      if (
        !isCoordinator(course, user) ||
        !course.groups ||
        !course.groups[groupType]?.length ||
        !(args.group >= 0 && args.group < course.groups[groupType].length) ||
        !canUpdateGroup(course, now)
      ) {
        throw new UserInputError('GROUP_ASSIGNMENT_FAILED')
      }

      // Update the group assignment of the student.
      if (!registration.group) {
        registration.group = {}
      }
      registration.group[groupType] = args.group

      // Save the registration into the database.
      try {
        return await registration.save()
      } catch (err) {
        Bugsnag.notify(err)
      }

      return null
    },
  },
}

export default resolvers
