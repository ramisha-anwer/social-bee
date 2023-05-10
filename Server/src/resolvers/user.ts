import { User } from "../entities/User";
import { MyContext } from "src/types";
import { EntityManager } from "@mikro-orm/postgresql";
import {
    Query,
    Resolver,
    Mutation,
    Field,
    Arg,
    Ctx,
    ObjectType,
} from "type-graphql";
import argon2 from "argon2"; //better than bycrypt according to stackoverflow
import { COOKIE_NAME, FORGET_PASSWORD_PREFIX } from "../constants";
import { UsernamePasswordInput } from "./UsernamePasswordInput";
import { validateRegister } from "../utils/validateRegister";
import { sendEmail } from "../utils/sendEmail";
import {v4} from "uuid";
import { validatePassword } from "../utils/validatePassword";

@ObjectType()
class FieldError {
    @Field()
    field: string; //what field is wrong

    @Field()
    message: string; // what is wrong with the field
}

@ObjectType() // object type is for returns
class UserResponse {
    @Field(() => [FieldError], { nullable: true })
    errors?: FieldError[]; //this will be the response if it fails

    @Field(() => User, { nullable: true })
    user?: User;
}

@Resolver()
export class UserResolver {
    @Mutation(() => UserResponse)
    async changePassword(
        @Arg('token') token: string,
        @Arg('password') newPassword: string,
        @Ctx() {em, redis, req}: MyContext
    ){
        // console.log(newPassword)
        var passwordError = validatePassword(newPassword)
        if(passwordError){
            
            return {errors: [
                {
                    field: "password",
                    message: "password length must be bigger than 3"
                }
            ]}
        };
        var key = FORGET_PASSWORD_PREFIX + token
        const userId = await redis.get(key);
        if(!userId){
            return {
                errors: [
                    {
                        field: "token",
                        message: " change password request has timed out",
                    }
                ]
            }
        }

        const user = await em.findOne(User, {id: parseInt(userId)});
        if(!user){
            return {
                errors: [
                    {
                        field: "user",
                        message: "user no longer exists",
                    }
                ]
            }
        }

        user.password = await argon2.hash(newPassword)
        await em.persistAndFlush(user);

        //one time you can change password
        await redis.del(key);
        // log in user after change password
        req.session.userId = user.id;

        return {user};
    }

    @Mutation(() => Boolean)
    async forgotPassword(
        @Arg('email') email : string,
        @Ctx() {em, redis} : MyContext // from context grabbing these
    ){
        const user = await em.findOne(User, {email});
        if(!user){
            //the email not in db
            return true;
        }

        const token = v4(); 

        await redis.set(
            FORGET_PASSWORD_PREFIX + token, 
            user.id, 
            'ex', 
            1000 * 60 * 60 * 24 * 3
        ); //upto 3 days 

        await sendEmail(email, 
            `<a href="http://localhost:3000/change-password/${token}"> reset password </a>`)
        return true;

    }


    @Query(() => User, {nullable: true})
    async me(@Ctx() {req, em}: MyContext) { // function that checks who the user is with cookie
        if(!req.session.userId){
            return null; //you are not logged in
        }

        const user = em.findOne(User, {id: req.session.userId});
        return user;
    }

    @Mutation(() => UserResponse) //its a query that returns string
    async register(
        @Arg("options") options: UsernamePasswordInput, // didnt write the type
        @Ctx() { em, req }: MyContext
    ): Promise<UserResponse> {
  
        const hashedPassword = await argon2.hash(options.password);
        // const user = em.create(User, {
        //     username: options.username,
        //     password: hashedPassword,
        // });
        let user;
        try{
            const errors = validateRegister(options)
            if(errors){
                return {errors};
            }
            //doing it with query builder
            const result = await (em as EntityManager).createQueryBuilder(User).getKnexQuery().insert(
                {
                    username: options.username,
                    email: options.email,
                    password: hashedPassword,
                    created_at: new Date(),
                    updated_at: new Date(),
                }
            ).returning("*"); //returning every field
            user = result[0]
            // await em.persistAndFlush(user); //doing it with persist and flush
        }
        catch(err){
            if(err.detail.includes("already exists")){
                return {errors: 
                    [   
                        {
                            field: "username",
                            message: "username already taken",
                        },
                    ]
                }
            } 
        }
        // loggin the user that just got created
        req.session.userId = user.id; 
        return {user};
    }

    @Mutation(() => UserResponse) //its a query that returns string
    async login(
        @Arg("usernameOrEmail") usernameOrEmail: string,
        @Arg("password") password: string,
        @Ctx() { em, req }: MyContext
    ): Promise<UserResponse> {
        const user = await em.findOne(User, 
            usernameOrEmail.includes('@') ? { email: usernameOrEmail } : { username: usernameOrEmail });
        if (!user) {
            if(usernameOrEmail.includes('@')){
                return {
                    errors:
                        [
                            {
                                field: "usernameOrEmail",
                                message: "email doesn't exist please go to register page to sign up",
                            },
                        ],
                };
            }
            return {
                errors:
                    [
                        {
                            field: "usernameOrEmail",
                            message: "username doesn't exist try to login with your email",
                        },
                    ],
            };
        }
        const valid = await argon2.verify(user.password, password);
        if (!valid) {
            return {
                errors:
                    [
                        {
                            field: "password",
                            message: "incorrect password",
                        }
                    ]
            }
        }
        req.session.userId = user.id; //setting user id when logged in

        return {
            user,
        };
    }

    @Query(() => [User]) //its a query that returns array 
    users( @Ctx() {em}: MyContext) : Promise<User []>{ //returns a promise of post
        
        return em.find(User, {}) //finds all the posts
    }

    @Mutation(() => Boolean)
    logout(@Ctx() { req, res }: MyContext) {
      return new Promise((resolve) =>
        req.session.destroy((err) => {
            res.clearCookie(COOKIE_NAME);
            if (err) {
                console.log(err);
                resolve(false);
                return;
            }
          resolve(true);
        })
      );
    }
}
